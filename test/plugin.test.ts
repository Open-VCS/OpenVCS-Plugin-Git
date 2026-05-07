// Copyright © 2025-2026 OpenVCS Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it } from 'node:test';

import {
  applySubmoduleStatusHints,
  buildCloneArgs,
  buildFetchArgs,
  buildPullFfOnlyArgs,
  buildPushArgs,
  buildSubmoduleUpdateArgs,
  parseCommits,
  parseStatusOutput,
} from '../src/plugin-helpers.js';

import { PluginDefinition, OnPluginStart } from '../src/plugin.js';
import { GitCommand, type ListCommitsOptions } from '../src/git.js';
import type { GitCommandResult } from '../src/plugin-types.js';
import { GitVcsDelegates, planDiscardPaths } from '../src/plugin-request-handler.js';

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

describe('Git plugin helpers', () => {
  describe('parseStatusOutput', () => {
    it('assigns old_path and path for staged rename records', () => {
      const status = parseStatusOutput('## main\0R  oldname.txt\0newname.txt\0');

      assert.deepStrictEqual(status.payload.files[0], {
        path: 'newname.txt',
        old_path: 'oldname.txt',
        status: 'R',
        staged: true,
        resolved_conflict: false,
        hunks: [],
      });
    });

    it('assigns old_path and path for copy records', () => {
      const status = parseStatusOutput('## main\0C  original.txt\0copy.txt\0');

      assert.deepStrictEqual(status.payload.files[0], {
        path: 'copy.txt',
        old_path: 'original.txt',
        status: 'C',
        staged: true,
        resolved_conflict: false,
        hunks: [],
      });
    });

    it('keeps rename ordering for unstaged rename records', () => {
      const status = parseStatusOutput('## main\0 R old.txt\0new.txt\0');

      assert.deepStrictEqual(status.payload.files[0], {
        path: 'new.txt',
        old_path: 'old.txt',
        status: 'R',
        staged: false,
        resolved_conflict: false,
        hunks: [],
      });
    });

    it('normalizes unmerged porcelain states to conflict status', () => {
      const status = parseStatusOutput('## main\0UU conflicted.txt\0');

      assert.equal(status.summary.conflicted, 1);
      assert.deepStrictEqual(status.payload.files[0], {
        path: 'conflicted.txt',
        old_path: null,
        status: 'U',
        staged: true,
        resolved_conflict: false,
        hunks: [],
      });
    });

    it('marks branch_on_remote when the status header includes upstream tracking', () => {
      const status = parseStatusOutput('## main...origin/main [ahead 1]\0');

      assert.equal(status.payload.branch_on_remote, true);
      assert.equal(status.payload.ahead, 1);
      assert.equal(status.payload.behind, 0);
    });

    it('only marks branch_on_remote for the porcelain branch header form', () => {
      const status = parseStatusOutput('## feature/branch...origin/feature/branch\0');

      assert.equal(status.payload.branch_on_remote, true);
    });

    it('clears branch_on_remote when the status header has no upstream tracking', () => {
      const status = parseStatusOutput('## main\0');

      assert.equal(status.payload.branch_on_remote, false);
      assert.equal(status.payload.ahead, 0);
      assert.equal(status.payload.behind, 0);
    });
  });

  describe('network command argument building', () => {
    it('builds fetch with no optional arguments', () => {
      assert.deepStrictEqual(buildFetchArgs({}), ['fetch']);
    });

    it('builds fetch with remote only', () => {
      assert.deepStrictEqual(buildFetchArgs({ remote: 'origin' }), [
        'fetch',
        'origin',
      ]);
    });

    it('builds fetch with remote and refspec', () => {
      assert.deepStrictEqual(
        buildFetchArgs({ remote: 'origin', refspec: 'main' }),
        ['fetch', 'origin', 'main'],
      );
    });

    it('builds fetch with prune enabled', () => {
      assert.deepStrictEqual(
        buildFetchArgs({ opts: { prune: true }, remote: 'origin' }),
        ['fetch', '--prune', 'origin'],
      );
    });

    it('builds clone with recursive submodules enabled', () => {
      assert.deepStrictEqual(buildCloneArgs({ url: 'https://example.com/repo.git', dest: 'repo' }), [
        'clone',
        '--recurse-submodules',
        'https://example.com/repo.git',
        'repo',
      ]);
    });

    it('builds push with no optional arguments', () => {
      assert.deepStrictEqual(buildPushArgs({}), ['push']);
    });

    it('builds pull --ff-only with no optional arguments', () => {
      assert.deepStrictEqual(buildPullFfOnlyArgs({}), ['pull', '--ff-only']);
    });

    it('builds pull --ff-only with remote and branch', () => {
      assert.deepStrictEqual(
        buildPullFfOnlyArgs({ remote: 'origin', branch: 'main' }),
        ['pull', '--ff-only', 'origin', 'main'],
      );
    });

    it('builds submodule update for one path', () => {
      assert.deepStrictEqual(buildSubmoduleUpdateArgs({ path: 'libs/example' }), [
        'submodule',
        'update',
        '--init',
        '--recursive',
        '--',
        'libs/example',
      ]);
    });

    it('builds submodule remote update recursively', () => {
      assert.deepStrictEqual(buildSubmoduleUpdateArgs({ remote: true }), [
        'submodule',
        'update',
        '--init',
        '--recursive',
        '--remote',
      ]);
    });
  });

  describe('submodule status hints', () => {
    it('marks known submodule paths distinctly in status payloads', () => {
      const parsed = parseStatusOutput('## main\0 M deps/example\0');
      const hinted = applySubmoduleStatusHints(parsed, ['deps/example']);

      assert.deepStrictEqual(hinted.payload.files[0], {
        path: 'deps/example',
        old_path: null,
        status: 'S',
        staged: false,
        resolved_conflict: false,
        hunks: [],
      });
    });
  });

  describe('discard path planning', () => {
    it('routes tracked files to restore and untracked files to clean', () => {
      const plan = planDiscardPaths(' M tracked.txt\0?? scratch.txt\0');

      assert.deepStrictEqual(plan, {
        restore: ['tracked.txt'],
        unstageThenRemove: [],
        clean: ['scratch.txt'],
      });
    });

    it('restores the old side of staged renames and removes the new side', () => {
      const plan = planDiscardPaths('R  old-name.txt\0new-name.txt\0');

      assert.deepStrictEqual(plan, {
        restore: ['old-name.txt'],
        unstageThenRemove: ['new-name.txt'],
        clean: ['new-name.txt'],
      });
    });

    it('cleans unstaged rename targets after restoring the original path', () => {
      const plan = planDiscardPaths(' R old-name.txt\0new-name.txt\0');

      assert.deepStrictEqual(plan, {
        restore: ['old-name.txt'],
        unstageThenRemove: [],
        clean: ['new-name.txt'],
      });
    });

    it('unstages and removes staged additions that do not exist in HEAD', () => {
      const plan = planDiscardPaths('A  added.txt\0');

      assert.deepStrictEqual(plan, {
        restore: [],
        unstageThenRemove: ['added.txt'],
        clean: ['added.txt'],
      });
    });

    it('unstages and removes staged copies that do not exist in HEAD', () => {
      const plan = planDiscardPaths('C  original.txt\0copy.txt\0');

      assert.deepStrictEqual(plan, {
        restore: [],
        unstageThenRemove: ['copy.txt'],
        clean: ['copy.txt'],
      });
    });
  });
});

describe('Git plugin exports', () => {
  describe('PluginDefinition', () => {
    it('is exported with the configured log target', () => {
      assert.ok(PluginDefinition, 'PluginDefinition is exported');
      assert.ok(PluginDefinition.logTarget, 'PluginDefinition has logTarget');
      assert.strictEqual(PluginDefinition.logTarget, 'openvcs.git.plugin');
    });

    it('registers vcs delegates during plugin startup', () => {
      OnPluginStart();

      const vcs = PluginDefinition.vcs;
      assert.ok(vcs, 'vcs delegates exist');
      assert.ok(vcs['vcs.open'], 'vcs.open delegate exists');
      assert.ok(vcs['vcs.close'], 'vcs.close delegate exists');
      assert.ok(vcs['vcs.get_caps'], 'vcs.get_caps delegate exists');
      assert.ok(vcs['vcs.clone_repo'], 'vcs.clone_repo delegate exists');
      assert.ok(vcs['vcs.get_workdir'], 'vcs.get_workdir delegate exists');
      assert.ok(vcs['vcs.get_current_branch'], 'vcs.get_current_branch delegate exists');
      assert.ok(vcs['vcs.list_branches'], 'vcs.list_branches delegate exists');
      assert.ok(vcs['vcs.list_local_branches'], 'vcs.list_local_branches delegate exists');
      assert.ok(vcs['vcs.create_branch'], 'vcs.create_branch delegate exists');
      assert.ok(vcs['vcs.checkout_branch'], 'vcs.checkout_branch delegate exists');
      assert.ok(vcs['vcs.fetch'], 'vcs.fetch delegate exists');
      assert.ok(vcs['vcs.push'], 'vcs.push delegate exists');
      assert.ok(vcs['vcs.pull_ff_only'], 'vcs.pull_ff_only delegate exists');
      assert.ok(vcs['vcs.commit'], 'vcs.commit delegate exists');
      assert.ok(vcs['vcs.get_status_summary'], 'vcs.get_status_summary delegate exists');
      assert.ok(vcs['vcs.get_status_payload'], 'vcs.get_status_payload delegate exists');
      assert.ok(vcs['vcs.list_commits'], 'vcs.list_commits delegate exists');
    });
  });

  describe('OnPluginStart', () => {
    it('is exported as a function', () => {
      assert.ok(OnPluginStart, 'OnPluginStart is exported');
      assert.strictEqual(typeof OnPluginStart, 'function', 'OnPluginStart is a function');
    });

    it('validates Git and attaches the delegate map', () => {
      OnPluginStart();
      assert.ok(PluginDefinition.vcs, 'PluginDefinition.vcs is populated at startup');
    });
  });
});

describe('Git commit integration', () => {
  it('stages partial patches against the current index', () => {
    const repoPath = createTempRepo();

    try {
      const git = new GitCommand(repoPath);
      writeFileSync(join(repoPath, 'tracked.txt'), 'staged\n', 'utf8');
      runGit(repoPath, ['add', 'tracked.txt']);
      writeFileSync(join(repoPath, 'tracked.txt'), 'staged\nunstaged\n', 'utf8');

      const patch = git.diffFile('tracked.txt');
      assert.match(patch, /\+unstaged/);

      git.stagePatch(patch);

      const cachedDiff = runGit(repoPath, ['diff', '--cached', '--', 'tracked.txt']);
      assert.match(cachedDiff, /\+staged/);
      assert.match(cachedDiff, /\+unstaged/);
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it('shows staged-only file diffs', () => {
    const repoPath = createTempRepo();

    try {
      const git = new GitCommand(repoPath);
      writeFileSync(join(repoPath, 'tracked.txt'), 'staged only\n', 'utf8');
      runGit(repoPath, ['add', 'tracked.txt']);

      const patch = git.diffFile('tracked.txt');

      assert.match(patch, /\+staged only/);
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it('commits only the index in commitIndex', () => {
    const repoPath = createTempRepo();

    try {
      const git = new GitCommand(repoPath);
      writeFileSync(join(repoPath, 'tracked.txt'), 'unstaged only\n', 'utf8');
      writeFileSync(join(repoPath, 'selected.txt'), 'selected\n', 'utf8');
      runGit(repoPath, ['add', 'selected.txt']);

      git.commitIndex('index only', 'Commit User', 'commit@example.com');

      assert.strictEqual(runGit(repoPath, ['show', 'HEAD:tracked.txt']), 'base');
      assert.strictEqual(runGit(repoPath, ['show', 'HEAD:selected.txt']), 'selected');
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it('returns the new head after delegate commitIndex', () => {
    const repoPath = createTempRepo();

    try {
      const delegates = new GitVcsDelegates(createDelegateDeps(repoPath));
      writeFileSync(join(repoPath, 'tracked.txt'), 'delegate index\n', 'utf8');
      runGit(repoPath, ['add', 'tracked.txt']);
      const previousHead = runGit(repoPath, ['rev-parse', 'HEAD']);

      const commitId = delegates.commitIndex(
        {
          session_id: 'session-1',
          message: 'delegate index commit',
          name: 'Delegate User',
          email: 'delegate@example.com',
        },
        {} as never,
      );

      const currentHead = runGit(repoPath, ['rev-parse', 'HEAD']);
      assert.notStrictEqual(currentHead, previousHead);
      assert.strictEqual(commitId, currentHead);
      assert.strictEqual(
        runGit(repoPath, ['log', '-1', '--format=%an <%ae>']),
        'Delegate User <delegate@example.com>',
      );
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it('returns the new head after delegate commit with paths', () => {
    const repoPath = createTempRepo();

    try {
      const delegates = new GitVcsDelegates(createDelegateDeps(repoPath));
      writeFileSync(join(repoPath, 'tracked.txt'), 'delegate path commit\n', 'utf8');
      const previousHead = runGit(repoPath, ['rev-parse', 'HEAD']);

      const commitId = delegates.commit(
        {
          session_id: 'session-1',
          message: 'delegate path commit',
          name: 'Path User',
          email: 'path@example.com',
          paths: ['tracked.txt'],
        },
        {} as never,
      );

      const currentHead = runGit(repoPath, ['rev-parse', 'HEAD']);
      assert.notStrictEqual(currentHead, previousHead);
      assert.strictEqual(commitId, currentHead);
      assert.strictEqual(
        runGit(repoPath, ['log', '-1', '--format=%an <%ae>']),
        'Path User <path@example.com>',
      );
      assert.strictEqual(runGit(repoPath, ['show', 'HEAD:tracked.txt']), 'delegate path commit');
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it('commits after staging with stage_paths for selected-path commit flow', () => {
    const repoPath = createTempRepo();

    try {
      const delegates = new GitVcsDelegates(createDelegateDeps(repoPath));
      writeFileSync(join(repoPath, 'tracked.txt'), 'staged via stage_paths\n', 'utf8');

      // Simulate selected-path flow: stage the path, then commit with paths
      delegates.stagePaths(
        {
          session_id: 'session-1',
          paths: ['tracked.txt'],
        },
        {} as never,
      );

      const commitId = delegates.commit(
        {
          session_id: 'session-1',
          message: 'commit after stage_paths',
          name: 'Stage User',
          email: 'stage@example.com',
          paths: ['tracked.txt'],
        },
        {} as never,
      );

      // Verify the staged change was committed
      const currentHead = runGit(repoPath, ['rev-parse', 'HEAD']);
      assert.strictEqual(commitId, currentHead);
      assert.strictEqual(runGit(repoPath, ['show', 'HEAD:tracked.txt']), 'staged via stage_paths');
      assert.strictEqual(
        runGit(repoPath, ['log', '-1', '--format=%an <%ae>']),
        'Stage User <stage@example.com>',
      );
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });
});

describe('Git commit parsing', () => {
  describe('parseCommits', () => {
    it('parses commit entries with hash, subject, author, and timestamp', () => {
      const rawOutput =
        'abc123def456789012345678901234567890ab\x00Initial commit\x00Test User\x002026-04-22T12:00:00Z\x00\x1e';
      const commits = parseCommits(rawOutput);

      assert.strictEqual(commits.length, 1);
      assert.strictEqual(commits[0].id, 'abc123def456789012345678901234567890ab');
      assert.strictEqual(commits[0].msg, 'Initial commit');
      assert.strictEqual(commits[0].author, 'Test User');
    });

    it('stops parsing at the record delimiter and handles multiple commits', () => {
      const rawOutput =
        'hash1\x00First\x00Author One\x002026-04-20T10:00:00Z\x00\x1e' +
        'hash2\x00Second\x00Author Two\x002026-04-21T11:00:00Z\x001e';
      const commits = parseCommits(rawOutput);

      assert.strictEqual(commits.length, 2);
      assert.strictEqual(commits[0].id, 'hash1');
      assert.strictEqual(commits[1].id, 'hash2');
    });

    it('handles empty input gracefully', () => {
      const commits = parseCommits('');
      assert.deepStrictEqual(commits, []);
    });

    it('omits empty records and trims whitespace', () => {
      const rawOutput = '  hash1\x00Message\x00Author\x002026-04-20T10:00:00Z\x00  \x1e  ';
      const commits = parseCommits(rawOutput);

      assert.strictEqual(commits.length, 1);
      assert.strictEqual(commits[0].id, 'hash1');
    });
  });

  describe('listCommits integration', () => {
    it('omits the git log limit flag when requesting the full history', () => {
      const git = new GitCommand('/tmp/mock-repo');
      let capturedArgs: string[] = [];
      git.run = ((args: string[]) => {
        capturedArgs = args;
        return { status: 0, stdout: '', stderr: '' };
      }) as GitCommand['run'];

      const result = git.listCommits({ limit: 0 });

      assert.deepStrictEqual(result.commits, []);
      assert.ok(!capturedArgs.includes('-0'));
      assert.deepStrictEqual(capturedArgs[0], 'log');
      assert.ok(!capturedArgs.includes('--all'));
    });

    it('excludes stash commits from default branch history', () => {
      const repoPath = createTempRepo();

      try {
        const git = new GitCommand(repoPath);
        writeFileSync(join(repoPath, 'tracked.txt'), 'stashed worktree\n', 'utf8');
        runGit(repoPath, ['stash', 'push', '-m', 'GitHub_Desktop<Dev>']);

        const result = git.listCommits({ limit: 10 });
        const messages = result.commits.map((commit) => commit.msg);

        assert.ok(!messages.some((message) => message.includes('GitHub_Desktop')));
      } finally {
        rmSync(repoPath, { recursive: true, force: true });
      }
    });

    it('populates commit id as the full hash and msg as the subject', () => {
      const repoPath = createTempRepo();

      try {
        const git = new GitCommand(repoPath);
        writeFileSync(join(repoPath, 'tracked.txt'), 'initial\n', 'utf8');
        runGit(repoPath, ['add', 'tracked.txt']);
        runGit(repoPath, ['commit', '-m', 'second commit']);

        const result = git.listCommits({});
        const head = result.commits[0];

        // The id must be exactly the 40-character hash, not hash+subject
        assert.match(head.id, /^[a-f0-9]{40}$/);
        assert.strictEqual(head.msg, 'second commit');

        // Verify we can diff the commit using its id
        const diff = git.diffCommit(head.id);
        assert.ok(diff.length > 0);
      } finally {
        rmSync(repoPath, { recursive: true, force: true });
      }
    });

    it('returns correct commit ids that can be used in git diff', () => {
      const repoPath = createTempRepo();

      try {
        const git = new GitCommand(repoPath);
        writeFileSync(join(repoPath, 'tracked.txt'), 'content\n', 'utf8');
        runGit(repoPath, ['add', 'tracked.txt']);
        runGit(repoPath, ['commit', '-m', 'add content']);

        const result = git.listCommits({ limit: 2 });
        const nonInitialCommits = result.commits.filter((c) => c.parent_oid);

        // Commit ids should be valid 40-char hashes
        for (const commit of result.commits) {
          assert.match(commit.id, /^[a-f0-9]{40}$/);
        }

        // Non-initial commits should work with diffCommit (they have parents)
        if (nonInitialCommits.length > 0) {
          const diff = git.diffCommit(nonInitialCommits[0].id);
          assert.ok(diff.length > 0);
        }
      } finally {
        rmSync(repoPath, { recursive: true, force: true });
      }
    });
  });

  describe('listCommits query validation', () => {
    it('forwards only actual boolean values to git.listCommits', () => {
      const calls: ListCommitsOptions[] = [];
      const delegates = createMockDelegate({
        listCommits: (options: ListCommitsOptions = {}) => {
          calls.push(options);
          return { commits: [], exitCode: 0 };
        },
      });

      delegates.listCommits(
        {
          session_id: 'session-1',
          query: { topo_order: true, include_merges: false },
        },
        {} as never,
      );
      delegates.listCommits(
        {
          session_id: 'session-1',
          query: { topo_order: 'invalid' as never, include_merges: 1 as never },
        },
        {} as never,
      );

      assert.deepStrictEqual(calls, [
        {
          branch: undefined,
          skip: undefined,
          limit: 0,
          topo_order: true,
          include_merges: false,
          author_contains: undefined,
          since_utc: undefined,
          until_utc: undefined,
          path: undefined,
        },
        {
          branch: undefined,
          skip: undefined,
          limit: 0,
          topo_order: undefined,
          include_merges: undefined,
          author_contains: undefined,
          since_utc: undefined,
          until_utc: undefined,
          path: undefined,
        },
      ]);
    });
  });

  describe('discardPaths fail-closed behavior', () => {
    it('skips clean and rethrows the original restore failure', () => {
      const calls: string[][] = [];
      const restoreFailure = new Error('restore failed');
      const statusResult: GitCommandResult = {
        status: 0,
        stdout: ' M tracked.txt\0?? scratch.txt\0',
        stderr: '',
      };
      const delegates = createMockDelegate({
        runChecked: (args: string[]) => {
          calls.push(args);
          if (args[0] === 'status') {
            return statusResult;
          }
          if (args[0] === 'restore') {
            throw restoreFailure;
          }
          return statusResult;
        },
      });

      assert.throws(
        () => delegates.discardPaths({ session_id: 'session-1', paths: ['tracked.txt', 'scratch.txt'] }, {} as never),
        (error) => error === restoreFailure,
      );
      assert.deepStrictEqual(calls, [
        ['status', '--porcelain=1', '-z', '-uall', '--', 'tracked.txt', 'scratch.txt'],
        ['restore', '--source=HEAD', '--staged', '--worktree', '--', 'tracked.txt'],
      ]);
    });
  });
});
