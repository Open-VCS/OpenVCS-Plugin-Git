// Copyright © 2025-2026 OpenVCS Contributors
// SPDX-License-Identifier: GPL-3.0-or-later
/// <reference types="node" />

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it } from 'node:test';

import type { PluginRuntimeContext } from '@openvcs/sdk/runtime';

import { GitCommand, type FetchOptions, type PullOptions } from '../src/git.js';
import { GitVcsDelegates } from '../src/plugin-request-handler.js';

/** Runs Git in a test repository and returns trimmed stdout. */
function runGit(repoPath: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repoPath,
    encoding: 'utf8',
  }).trim();
}

/** Creates one temporary Git repository seeded with an initial commit. */
function createTempRepo(): string {
  const repoPath = mkdtempSync(join(tmpdir(), 'openvcs-git-plugin-'));
  runGit(repoPath, ['init']);
  runGit(repoPath, ['config', 'user.name', 'Test User']);
  runGit(repoPath, ['config', 'user.email', 'test@example.com']);
  writeFileSync(join(repoPath, 'tracked.txt'), 'base\n', 'utf8');
  runGit(repoPath, ['add', 'tracked.txt']);
  runGit(repoPath, ['commit', '-m', 'initial']);
  return repoPath;
}

/** Creates delegate dependencies that always resolve a single temp repo session. */
function createDelegateDeps(repoPath: string) {
  return {
    allocateSession: () => 'session-1',
    closeSession: () => {},
    requireSession: () => ({ path: repoPath }),
    createGitCommand: (cwd: string) => new GitCommand(cwd),
  };
}

/** Creates delegate dependencies backed by one mock git command. */
function createMockDelegate(mockGit: Partial<GitCommand>) {
  return new GitVcsDelegates({
    allocateSession: () => 'session-1',
    closeSession: () => {},
    requireSession: () => ({ path: '/tmp/mock-repo' }),
    createGitCommand: () => mockGit as GitCommand,
  });
}

/** Creates a minimal runtime context for direct delegate invocation. */
function createRuntimeContext(): PluginRuntimeContext {
  return {
    host: {} as PluginRuntimeContext['host'],
    requestId: '1',
    method: 'vcs.create_branch',
  };
}

describe('GitVcsDelegates unit tests', () => {
  describe('getCaps', () => {
    it('returns full capabilities', () => {
      const delegates = createMockDelegate({});
      const caps = delegates.getCaps({}, createRuntimeContext());
      assert.strictEqual(caps.commits, true);
      assert.strictEqual(caps.branches, true);
      assert.strictEqual(caps.staging, true);
      assert.strictEqual(caps.push_pull, true);
    });
  });

  describe('open', () => {
    it('validates repo path and creates session', () => {
      const repoPath = createTempRepo();
      try {
        const deps = createDelegateDeps(repoPath);
        const delegates = new GitVcsDelegates(deps);
        const result = delegates.open({ path: repoPath }, createRuntimeContext());
        assert.ok(result.session_id);
      } finally {
        rmSync(repoPath, { recursive: true, force: true });
      }
    });

    it('throws when path is empty', () => {
      const delegates = createMockDelegate({});
      assert.throws(
        () => delegates.open({ path: '' }, createRuntimeContext()),
        (err: Error) => {
          assert.match(err.message, /path is required/);
          return true;
        },
      );
    });
  });

  describe('close', () => {
    it('closes the session', () => {
      const closeCalls: string[] = [];
      const delegates = new GitVcsDelegates({
        allocateSession: () => 'session-1',
        closeSession: (id: unknown) => { closeCalls.push(String(id)); },
        requireSession: () => ({ path: '/tmp/repo' }),
        createGitCommand: () => new GitCommand('/tmp/repo'),
      });
      delegates.close({ session_id: 'session-1' }, createRuntimeContext());
      assert.deepStrictEqual(closeCalls, ['session-1']);
    });
  });

  describe('getWorkdir', () => {
    it('returns the session path', () => {
      const delegates = createMockDelegate({});
      const workdir = delegates.getWorkdir({ session_id: 'session-1' }, createRuntimeContext());
      assert.strictEqual(workdir, '/tmp/mock-repo');
    });
  });

  describe('getCurrentBranch', () => {
    it('returns the branch name when not in detached HEAD', () => {
      const delegates = createMockDelegate({
        currentBranch: () => 'main',
      });
      const branch = delegates.getCurrentBranch({ session_id: 'session-1' }, createRuntimeContext());
      assert.strictEqual(branch, 'main');
    });

    it('returns null when in detached HEAD state', () => {
      const delegates = createMockDelegate({
        currentBranch: () => 'HEAD',
      });
      const branch = delegates.getCurrentBranch({ session_id: 'session-1' }, createRuntimeContext());
      assert.strictEqual(branch, null);
    });
  });

  describe('listBranches', () => {
    it('parses for-each-ref output', () => {
      const delegates = createMockDelegate({
        runChecked: () => ({
          status: 0,
          stdout: 'main\trefs/heads/main\t*\nfeature\trefs/heads/feature\t\norigin/main\trefs/remotes/origin/main\t\n',
          stderr: '',
        }),
      });
      const branches = delegates.listBranches({ session_id: 'session-1' }, createRuntimeContext());
      assert.strictEqual(branches.length, 3);
      assert.strictEqual(branches[0].name, 'main');
      assert.strictEqual(branches[0].current, true);
      assert.strictEqual(branches[1].kind.type, 'Local');
      assert.strictEqual(branches[2].kind.type, 'Remote');
      assert.strictEqual((branches[2].kind as { type: string; remote: string }).remote, 'origin');
    });
  });

  describe('listLocalBranches', () => {
    it('parses for-each-ref output for local branches', () => {
      const delegates = createMockDelegate({
        runChecked: () => ({
          status: 0,
          stdout: 'main\nfeature\n',
          stderr: '',
        }),
      });
      const branches = delegates.listLocalBranches({ session_id: 'session-1' }, createRuntimeContext());
      assert.deepStrictEqual(branches, ['main', 'feature']);
    });
  });

  describe('createBranch', () => {
    it('creates a branch without checkout', () => {
      const calls: string[] = [];
      const delegates = createMockDelegate({
        createBranch: (name: string) => { calls.push(`create:${name}`); },
      });
      delegates.createBranch({ session_id: 'session-1', name: 'feature/x', checkout: false }, createRuntimeContext());
      assert.deepStrictEqual(calls, ['create:feature/x']);
    });
  });

  describe('checkoutBranch', () => {
    it('delegates to git checkout', () => {
      const calls: string[] = [];
      const delegates = createMockDelegate({
        checkoutBranch: (name: string) => { calls.push(`checkout:${name}`); },
      });
      delegates.checkoutBranch({ session_id: 'session-1', name: 'main' }, createRuntimeContext());
      assert.deepStrictEqual(calls, ['checkout:main']);
    });
  });

  describe('ensureRemote', () => {
    it('validates name and url presence', () => {
      const delegates = createMockDelegate({});
      assert.throws(
        () => delegates.ensureRemote({ session_id: 'session-1', name: '', url: '' }, createRuntimeContext()),
        (err: Error) => {
          assert.match(err.message, /name and url are required/);
          return true;
        },
      );
    });

    it('delegates to git ensureRemote with valid args', () => {
      const calls: Array<{ name: string; url: string }> = [];
      const delegates = createMockDelegate({
        ensureRemote: (name: string, url: string) => { calls.push({ name, url }); },
      });
      delegates.ensureRemote({ session_id: 'session-1', name: 'origin', url: 'https://example.com/repo.git' }, createRuntimeContext());
      assert.deepStrictEqual(calls, [{ name: 'origin', url: 'https://example.com/repo.git' }]);
    });
  });

  describe('listRemotes', () => {
    it('maps remote entries', () => {
      const delegates = createMockDelegate({
        listRemotes: () => ({
          remotes: [
            { name: 'origin', fetch: 'https://example.com/repo.git', push: 'https://example.com/repo.git' },
          ],
        }),
      });
      const remotes = delegates.listRemotes({ session_id: 'session-1' }, createRuntimeContext());
      assert.strictEqual(remotes.length, 1);
      assert.strictEqual(remotes[0].url, 'https://example.com/repo.git');
    });
  });

  describe('removeRemote', () => {
    it('delegates to git removeRemote', () => {
      const calls: string[] = [];
      const delegates = createMockDelegate({
        removeRemote: (name: string) => { calls.push(name); },
      });
      delegates.removeRemote({ session_id: 'session-1', name: 'origin' }, createRuntimeContext());
      assert.deepStrictEqual(calls, ['origin']);
    });
  });

  describe('fetch', () => {
    it('delegates to git fetch with options', () => {
      const calls: FetchOptions[] = [];
      const delegates = createMockDelegate({
        fetch: (opts: FetchOptions) => {
          calls.push(opts);
          return { status: 0, stdout: '', stderr: '' };
        },
      });
      delegates.fetch({ session_id: 'session-1', remote: 'origin', refspec: 'main', opts: { prune: true } }, createRuntimeContext());
      assert.strictEqual(calls.length, 1);
      assert.strictEqual(calls[0].remote, 'origin');
      assert.strictEqual(calls[0].opts?.prune, true);
    });

    it('coerces empty fetch options to undefined values', () => {
      const calls: FetchOptions[] = [];
      const delegates = createMockDelegate({
        fetch: (opts: FetchOptions) => {
          calls.push(opts);
          return { status: 0, stdout: '', stderr: '' };
        },
      });

      delegates.fetch({ session_id: 'session-1', remote: ' ', refspec: '', opts: {} }, createRuntimeContext());

      assert.deepStrictEqual(calls, [{ remote: undefined, refspec: undefined, opts: { prune: false } }]);
    });
  });

  describe('push', () => {
    it('delegates to git push with options', () => {
      const calls: Array<{ remote?: string; refspec?: string }> = [];
      const delegates = createMockDelegate({
        push: (opts: { remote?: string; refspec?: string }) => {
          calls.push(opts);
          return { status: 0, stdout: '', stderr: '' };
        },
      });
      delegates.push({ session_id: 'session-1', remote: 'origin', refspec: 'main' }, createRuntimeContext());
      assert.deepStrictEqual(calls, [{ remote: 'origin', refspec: 'main' }]);
    });

    it('coerces empty push fields to undefined', () => {
      const calls: Array<{ remote?: string; refspec?: string }> = [];
      const delegates = createMockDelegate({
        push: (opts: { remote?: string; refspec?: string }) => {
          calls.push(opts);
          return { status: 0, stdout: '', stderr: '' };
        },
      });

      delegates.push({ session_id: 'session-1', remote: '', refspec: ' ' }, createRuntimeContext());

      assert.deepStrictEqual(calls, [{ remote: undefined, refspec: undefined }]);
    });
  });

  describe('pullFfOnly', () => {
    it('delegates to git pull with options', () => {
      const calls: PullOptions[] = [];
      const delegates = createMockDelegate({
        pull: (opts: PullOptions) => {
          calls.push(opts);
          return { status: 0, stdout: '', stderr: '' };
        },
      });
      delegates.pullFfOnly({ session_id: 'session-1', remote: 'origin', branch: 'main' }, createRuntimeContext());
      assert.strictEqual(calls.length, 1);
      assert.strictEqual(calls[0].remote, 'origin');
      assert.strictEqual(calls[0].branch, 'main');
    });

    it('coerces empty pull fields to undefined', () => {
      const calls: PullOptions[] = [];
      const delegates = createMockDelegate({
        pull: (opts: PullOptions) => {
          calls.push(opts);
          return { status: 0, stdout: '', stderr: '' };
        },
      });

      delegates.pullFfOnly({ session_id: 'session-1', remote: '', branch: ' ' }, createRuntimeContext());

      assert.deepStrictEqual(calls, [{ remote: undefined, branch: undefined }]);
    });
  });

  describe('getStatusSummary', () => {
    it('returns the status summary from git status', () => {
      const delegates = createMockDelegate({
        status: () => ({
          summary: { untracked: 1, modified: 2, staged: 3, conflicted: 0 },
          payload: { files: [], ahead: 0, behind: 0, branch_on_remote: false },
          exitCode: 0,
        }),
      });
      const summary = delegates.getStatusSummary({ session_id: 'session-1' }, createRuntimeContext());
      assert.strictEqual(summary.untracked, 1);
      assert.strictEqual(summary.modified, 2);
      assert.strictEqual(summary.staged, 3);
    });
  });

  describe('getStatusPayload', () => {
    it('returns the status payload from git status', () => {
      const delegates = createMockDelegate({
        status: () => ({
          summary: { untracked: 0, modified: 0, staged: 0, conflicted: 0 },
          payload: { files: [{ path: 'file.txt', old_path: null, status: 'M', staged: true, resolved_conflict: false, hunks: [], binary: false }], ahead: 0, behind: 0, branch_on_remote: false },
          exitCode: 0,
        }),
      });
      const payload = delegates.getStatusPayload({ session_id: 'session-1' }, createRuntimeContext());
      assert.strictEqual(payload.files.length, 1);
      assert.strictEqual(payload.files[0].path, 'file.txt');
      assert.strictEqual(payload.files[0].binary, false);
    });
  });

  describe('getConflictDetails', () => {
    it('delegates to git getConflictDetails', () => {
      const delegates = createMockDelegate({
        getConflictDetails: (path: string) => ({
          path,
          ours: 'our content',
          theirs: 'their content',
          base: null,
          binary: false,
        }),
      });
      const details = delegates.getConflictDetails({ session_id: 'session-1', path: 'conflict.txt' }, createRuntimeContext());
      assert.strictEqual(details.ours, 'our content');
      assert.strictEqual(details.path, 'conflict.txt');
    });
  });

  describe('checkoutConflictSide', () => {
    it('validates side parameter', () => {
      const delegates = createMockDelegate({});
      assert.throws(
        () => delegates.checkoutConflictSide({ session_id: 'session-1', path: 'file.txt', side: 'invalid' }, createRuntimeContext()),
        (err: Error) => {
          assert.match(err.message, /side must be "ours" or "theirs"/);
          return true;
        },
      );
    });

    it('accepts "ours" as valid side', () => {
      const calls: string[] = [];
      const delegates = createMockDelegate({
        checkoutConflictSide: (path: string, side: string) => { calls.push(`${side}:${path}`); },
      });
      delegates.checkoutConflictSide({ session_id: 'session-1', path: 'file.txt', side: 'ours' }, createRuntimeContext());
      assert.deepStrictEqual(calls, ['ours:file.txt']);
    });
  });

  describe('deleteBranch', () => {
    it('delegates to git deleteBranch', () => {
      const calls: string[] = [];
      const delegates = createMockDelegate({
        deleteBranch: (name: string) => { calls.push(name); },
      });
      delegates.deleteBranch({ session_id: 'session-1', name: 'old-branch' }, createRuntimeContext());
      assert.deepStrictEqual(calls, ['old-branch']);
    });
  });

  describe('renameBranch', () => {
    it('delegates to git renameBranch', () => {
      const calls: Array<{ old: string; new: string }> = [];
      const delegates = createMockDelegate({
        renameBranch: (oldName: string, newName: string) => { calls.push({ old: oldName, new: newName }); },
      });
      delegates.renameBranch({ session_id: 'session-1', old: 'old-name', new: 'new-name' }, createRuntimeContext());
      assert.deepStrictEqual(calls, [{ old: 'old-name', new: 'new-name' }]);
    });
  });

  describe('getBranchUpstream', () => {
    it('delegates to git getBranchUpstream', () => {
      const calls: string[] = [];
      const delegates = createMockDelegate({
        getBranchUpstream: (branch: string) => { calls.push(branch); return 'origin/main'; },
      });
      const result = delegates.getBranchUpstream({ session_id: 'session-1', branch: 'main' }, createRuntimeContext());
      assert.deepStrictEqual(calls, ['main']);
      assert.strictEqual(result, 'origin/main');
    });
  });

  describe('setBranchUpstream', () => {
    it('delegates to git setBranchUpstream', () => {
      const calls: Array<{ branch: string; upstream: string }> = [];
      const delegates = createMockDelegate({
        setBranchUpstream: (branch: string, upstream: string) => { calls.push({ branch, upstream }); },
      });
      delegates.setBranchUpstream({ session_id: 'session-1', branch: 'main', upstream: 'origin/main' }, createRuntimeContext());
      assert.deepStrictEqual(calls, [{ branch: 'main', upstream: 'origin/main' }]);
    });
  });

  describe('merge operations', () => {
    it('mergeIntoCurrent delegates to git', () => {
      const calls: string[] = [];
      const delegates = createMockDelegate({
        mergeIntoCurrent: (name: string) => { calls.push(name); },
      });
      delegates.mergeIntoCurrent({ session_id: 'session-1', name: 'feature' }, createRuntimeContext());
      assert.deepStrictEqual(calls, ['feature']);
    });

    it('mergeAbort delegates to git', () => {
      let called = false;
      const delegates = createMockDelegate({
        mergeAbort: () => { called = true; },
      });
      delegates.mergeAbort({ session_id: 'session-1' }, createRuntimeContext());
      assert.strictEqual(called, true);
    });

    it('mergeContinue delegates to git with message', () => {
      const calls: Array<string | undefined> = [];
      const delegates = createMockDelegate({
        mergeContinue: (message?: string) => { calls.push(message); },
      });
      delegates.mergeContinue({ session_id: 'session-1', message: 'merge msg' }, createRuntimeContext());
      assert.deepStrictEqual(calls, ['merge msg']);
    });

    it('mergeContinue converts blank message to undefined', () => {
      const calls: Array<string | undefined> = [];
      const delegates = createMockDelegate({
        mergeContinue: (message?: string) => { calls.push(message); },
      });

      delegates.mergeContinue({ session_id: 'session-1', message: ' ' }, createRuntimeContext());

      assert.deepStrictEqual(calls, [undefined]);
    });

    it('isMergeInProgress delegates to git', () => {
      const delegates = createMockDelegate({
        isMergeInProgress: () => true,
      });
      assert.strictEqual(delegates.isMergeInProgress({ session_id: 'session-1' }, createRuntimeContext()), true);
    });
  });

  describe('hardResetHead', () => {
    it('delegates to git hardResetHead with ref', () => {
      const calls: Array<string | undefined> = [];
      const delegates = createMockDelegate({
        hardResetHead: (ref?: string) => { calls.push(ref); },
      });
      delegates.hardResetHead({ session_id: 'session-1', ref: 'abc123' }, createRuntimeContext());
      assert.deepStrictEqual(calls, ['abc123']);
    });

    it('delegates without ref', () => {
      const calls: Array<string | undefined> = [];
      const delegates = createMockDelegate({
        hardResetHead: (ref?: string) => { calls.push(ref); },
      });
      delegates.hardResetHead({ session_id: 'session-1' }, createRuntimeContext());
      assert.deepStrictEqual(calls, [undefined]);
    });
  });

  describe('resetSoftTo', () => {
    it('delegates to git resetSoftTo', () => {
      const calls: string[] = [];
      const delegates = createMockDelegate({
        resetSoftTo: (ref: string) => { calls.push(ref); },
      });
      delegates.resetSoftTo({ session_id: 'session-1', rev: 'abc123' }, createRuntimeContext());
      assert.deepStrictEqual(calls, ['abc123']);
    });
  });

  describe('identity operations', () => {
    it('getIdentity delegates to git', () => {
      const delegates = createMockDelegate({
        getIdentity: () => ({ name: 'Test User', email: 'test@example.com' }),
      });
      const identity = delegates.getIdentity({ session_id: 'session-1' }, createRuntimeContext());
      assert.deepStrictEqual(identity, { name: 'Test User', email: 'test@example.com' });
    });

    it('setIdentityLocal delegates to git', () => {
      const calls: Array<{ name: string; email: string }> = [];
      const delegates = createMockDelegate({
        setIdentityLocal: (name: string, email: string) => { calls.push({ name, email }); },
      });
      delegates.setIdentityLocal({ session_id: 'session-1', name: 'User', email: 'user@example.com' }, createRuntimeContext());
      assert.deepStrictEqual(calls, [{ name: 'User', email: 'user@example.com' }]);
    });
  });

  describe('stash operations', () => {
    it('listStashes delegates to git', () => {
      const delegates = createMockDelegate({
        listStashes: () => [{ selector: 'stash@{0}', msg: 'WIP', meta: '' }],
      });
      const stashes = delegates.listStashes({ session_id: 'session-1' }, createRuntimeContext());
      assert.strictEqual(stashes.length, 1);
    });

    it('stashPush delegates to git', () => {
      const calls: Array<{ message?: string; includeUntracked?: boolean }> = [];
      const delegates = createMockDelegate({
        stashPush: (message?: string, includeUntracked?: boolean) => {
          calls.push({ message, includeUntracked });
          return 'stash@{0}';
        },
      });
      delegates.stashPush({ session_id: 'session-1', message: 'test', include_untracked: true }, createRuntimeContext());
      assert.deepStrictEqual(calls, [{ message: 'test', includeUntracked: true }]);
    });

    it('stashPush converts blank message to undefined', () => {
      const calls: Array<{ message?: string; includeUntracked?: boolean }> = [];
      const delegates = createMockDelegate({
        stashPush: (message?: string, includeUntracked?: boolean) => {
          calls.push({ message, includeUntracked });
          return 'stash@{0}';
        },
      });

      delegates.stashPush({ session_id: 'session-1', message: ' ', include_untracked: false }, createRuntimeContext());

      assert.deepStrictEqual(calls, [{ message: undefined, includeUntracked: false }]);
    });

    it('stashApply delegates to git', () => {
      const calls: string[] = [];
      const delegates = createMockDelegate({
        stashApply: (selector: string) => { calls.push(selector); },
      });
      delegates.stashApply({ session_id: 'session-1', selector: 'stash@{0}' }, createRuntimeContext());
      assert.deepStrictEqual(calls, ['stash@{0}']);
    });

    it('stashPop delegates to git', () => {
      const calls: string[] = [];
      const delegates = createMockDelegate({
        stashPop: (selector: string) => { calls.push(selector); },
      });
      delegates.stashPop({ session_id: 'session-1', selector: 'stash@{0}' }, createRuntimeContext());
      assert.deepStrictEqual(calls, ['stash@{0}']);
    });

    it('stashDrop delegates to git', () => {
      const calls: string[] = [];
      const delegates = createMockDelegate({
        stashDrop: (selector: string) => { calls.push(selector); },
      });
      delegates.stashDrop({ session_id: 'session-1', selector: 'stash@{0}' }, createRuntimeContext());
      assert.deepStrictEqual(calls, ['stash@{0}']);
    });

    it('stashShow delegates to git', () => {
      const calls: string[] = [];
      const delegates = createMockDelegate({
        stashShow: (selector: string) => { calls.push(selector); return 'diff'; },
      });
      const result = delegates.stashShow({ session_id: 'session-1', selector: 'stash@{0}' }, createRuntimeContext());
      assert.deepStrictEqual(calls, ['stash@{0}']);
      assert.strictEqual(result, 'diff');
    });
  });

  describe('cherry pick and revert', () => {
    it('cherryPick delegates to git', () => {
      const calls: string[] = [];
      const delegates = createMockDelegate({
        cherryPick: (commit: string) => { calls.push(commit); },
      });
      delegates.cherryPick({ session_id: 'session-1', commit: 'abc123' }, createRuntimeContext());
      assert.deepStrictEqual(calls, ['abc123']);
    });

    it('revertCommit delegates to git', () => {
      const calls: Array<{ commit: string; noEdit?: boolean }> = [];
      const delegates = createMockDelegate({
        revertCommit: (commit: string, noEdit?: boolean) => { calls.push({ commit, noEdit }); },
      });
      delegates.revertCommit({ session_id: 'session-1', commit: 'abc123', no_edit: true }, createRuntimeContext());
      assert.deepStrictEqual(calls, [{ commit: 'abc123', noEdit: true }]);
    });
  });

  describe('applyReversePatch', () => {
    it('delegates to git applyReversePatch', () => {
      const calls: string[] = [];
      const delegates = createMockDelegate({
        applyReversePatch: (patch: string) => { calls.push(patch); },
      });
      delegates.applyReversePatch({ session_id: 'session-1', patch: 'some-patch' }, createRuntimeContext());
      assert.deepStrictEqual(calls, ['some-patch']);
    });
  });

  describe('discardPaths with empty paths', () => {
    it('returns early when no paths provided', () => {
      let called = false;
      const delegates = createMockDelegate({
        runChecked: () => { called = true; return { status: 0, stdout: '', stderr: '' }; },
      });
      delegates.discardPaths({ session_id: 'session-1', paths: [] }, createRuntimeContext());
      assert.strictEqual(called, false);
    });
  });

  describe('discardPaths with unstageThenRemove failure', () => {
    it('rethrows the rm failure and skips subsequent operations', () => {
      const rmFailure = new Error('rm failed');
      const delegates = createMockDelegate({
        runChecked: (args: string[]) => {
          if (args[0] === 'status') {
            return { status: 0, stdout: 'A  added.txt\0', stderr: '' };
          }
          if (args[0] === 'rm') {
            throw rmFailure;
          }
          return { status: 0, stdout: '', stderr: '' };
        },
      });
      assert.throws(
        () => delegates.discardPaths({ session_id: 'session-1', paths: ['added.txt'] }, createRuntimeContext()),
        (error: unknown) => error === rmFailure,
      );
    });
  });

  describe('stagePaths', () => {
    it('delegates to git stagePaths', () => {
      const calls: string[][] = [];
      const delegates = createMockDelegate({
        stagePaths: (paths: string[]) => { calls.push(paths); },
      });
      delegates.stagePaths({ session_id: 'session-1', paths: ['file1.txt', 'file2.txt'] }, createRuntimeContext());
      assert.deepStrictEqual(calls, [['file1.txt', 'file2.txt']]);
    });
  });

  describe('writeMergeResult', () => {
    it('decodes base64 content and delegates to git', () => {
      const calls: Array<{ path: string; content: string }> = [];
      const delegates = createMockDelegate({
        writeMergeResult: (path: string, content: string) => { calls.push({ path, content }); },
      });
      const b64Content = Buffer.from('merged content').toString('base64');
      delegates.writeMergeResult({ session_id: 'session-1', path: 'file.txt', content_b64: b64Content }, createRuntimeContext());
      assert.strictEqual(calls[0].path, 'file.txt');
      assert.strictEqual(calls[0].content, 'merged content');
    });
  });

  describe('discardPaths with clean-only paths', () => {
    it('only runs clean for untracked paths', () => {
      const calls: string[][] = [];
      const delegates = createMockDelegate({
        runChecked: (args: string[]) => {
          calls.push(args);
          if (args[0] === 'status') {
            return { status: 0, stdout: '?? scratch.txt\0', stderr: '' };
          }
          return { status: 0, stdout: '', stderr: '' };
        },
      });
      delegates.discardPaths({ session_id: 'session-1', paths: ['scratch.txt'] }, createRuntimeContext());
      assert.ok(calls.some((call) => call[0] === 'clean'));
    });
  });

  describe('stagePatch delegate', () => {
    it('delegates stagePatch with asString coercion', () => {
      const calls: string[] = [];
      const delegates = createMockDelegate({
        stagePatch: (patch: string) => { calls.push(patch); },
      });
      delegates.stagePatch({ session_id: 'session-1', patch: 'test-patch' }, createRuntimeContext());
      assert.deepStrictEqual(calls, ['test-patch']);
    });
  });

  describe('diffFile delegate', () => {
    it('returns structured diff payloads from git', () => {
      const delegates = createMockDelegate({
        diffFile: () => ({ lines: ['line1', 'line2', 'line3'], binary: false }),
      });
      const diff = delegates.diffFile({ session_id: 'session-1', path: 'file.txt' }, createRuntimeContext());
      assert.deepStrictEqual(diff, { lines: ['line1', 'line2', 'line3'], binary: false });
    });
  });

  describe('diffCommit delegate', () => {
    it('splits commit diff output into lines', () => {
      const delegates = createMockDelegate({
        diffCommit: () => 'change1\nchange2',
      });
      const lines = delegates.diffCommit({ session_id: 'session-1', rev: 'abc123' }, createRuntimeContext());
      assert.deepStrictEqual(lines, ['change1', 'change2']);
    });
  });

  describe('cloneRepo', () => {
    it('throws when url or destination is empty', () => {
      const delegates = createMockDelegate({});

      assert.throws(
        () => delegates.cloneRepo({ session_id: 'session-1', url: '', dest: '' }, createRuntimeContext()),
        (err: Error) => {
          assert.match(err.message, /url and dest are required/);
          return true;
        },
      );
    });

    it('delegates to git clone and forwards output lines', () => {
      const infoCalls: string[] = [];
      const delegates = createMockDelegate({
        runChecked: () => ({
          status: 0,
          stdout: 'Cloning into repo...\nReceiving objects: 100%\n',
          stderr: 'Resolving deltas: 100%\n',
        }),
      });
      delegates.cloneRepo(
        { session_id: 'session-1', url: 'https://example.com/repo.git', dest: '/tmp/repo' },
        { host: { info: (msg: string) => { infoCalls.push(msg); } } as PluginRuntimeContext['host'], requestId: '1', method: 'vcs.clone_repo' },
      );
      assert.ok(infoCalls.some((c) => c.includes('Cloning')));
      assert.ok(infoCalls.some((c) => c.includes('Resolving')));
    });
  });
});
