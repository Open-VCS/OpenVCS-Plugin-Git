// Copyright © 2025-2026 OpenVCS Contributors
// SPDX-License-Identifier: GPL-3.0-or-later
/// <reference types="node" />

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it } from 'node:test';

import type { PluginRuntimeContext } from '@openvcs/sdk/runtime';

import { parseCommits } from '../src/plugin-helpers.js';

import { PluginDefinition, OnPluginStart } from '../src/plugin.js';
import { GitCommand, type ListCommitsOptions } from '../src/git.js';
import type { GitCommandResult } from '../src/plugin-types.js';
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

    it('checks out the branch when create_branch receives checkout=true', () => {
      const calls: string[] = [];
      const delegates = createMockDelegate({
        createBranch: (name: string) => {
          calls.push(`create:${name}`);
        },
        checkoutBranch: (name: string) => {
          calls.push(`checkout:${name}`);
        },
      });

      delegates.createBranch(
        { session_id: 'session-1', name: 'feature/test', checkout: true },
        createRuntimeContext(),
      );

      assert.deepStrictEqual(calls, ['create:feature/test', 'checkout:feature/test']);
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
  it('returns an empty diff array when stdout is empty', () => {
    const delegates = createMockDelegate({
      diffFile: () => ({ lines: [], binary: false }),
      diffCommit: () => '',
    });

    const fileDiff = delegates.diffFile(
      { session_id: 'session-1', path: 'tracked.txt' } as never,
      createRuntimeContext(),
    );
    const commitDiff = delegates.diffCommit(
      { session_id: 'session-1', rev: 'HEAD' } as never,
      createRuntimeContext(),
    );

    assert.deepStrictEqual(fileDiff, { lines: [], binary: false });
    assert.deepStrictEqual(commitDiff, []);
  });

  it('stages partial patches against the current index', () => {
    const repoPath = createTempRepo();

    try {
      const git = new GitCommand(repoPath);
      writeFileSync(join(repoPath, 'tracked.txt'), 'staged\n', 'utf8');
      runGit(repoPath, ['add', 'tracked.txt']);
      writeFileSync(join(repoPath, 'tracked.txt'), 'staged\nunstaged\n', 'utf8');

      const patch = git.diffFile('tracked.txt');
      const patchText = patch.lines.join('\n');
      assert.match(patchText, /\+staged/);
      assert.match(patchText, /\+unstaged/);

      git.stagePatch(`${patchText}\n`);

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
      const patchText = patch.lines.join('\n');

      assert.match(patchText, /\+staged only/);
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

  it('commits staged untracked files through the index', () => {
    const repoPath = createTempRepo();

    try {
      const git = new GitCommand(repoPath);
      mkdirSync(join(repoPath, 'content/posts/2026/05'), { recursive: true });
      writeFileSync(join(repoPath, 'content/posts/2026/05/openvcs-announcement.md'), 'hello\n', 'utf8');

      git.stagePaths(['content/posts/2026/05/openvcs-announcement.md']);
      git.commitIndex('new file commit', 'New File User', 'newfile@example.com');

      assert.strictEqual(
        runGit(repoPath, ['show', 'HEAD:content/posts/2026/05/openvcs-announcement.md']),
        'hello',
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

    it('propagates git log failures', () => {
      const git = new GitCommand('/tmp/mock-repo');
      git.runChecked = (() => {
        throw new Error('git log failed');
      }) as GitCommand['runChecked'];

      assert.throws(() => git.listCommits({}), /git log failed/);
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

        assert.match(head.id, /^[a-f0-9]{40}$/);
        assert.strictEqual(head.msg, 'second commit');

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

        for (const commit of result.commits) {
          assert.match(commit.id, /^[a-f0-9]{40}$/);
        }

        if (nonInitialCommits.length > 0) {
          const diff = git.diffCommit(nonInitialCommits[0].id);
          assert.ok(diff.length > 0);
        }
      } finally {
        rmSync(repoPath, { recursive: true, force: true });
      }
    });

    it('diffs the root commit against the empty tree', () => {
      const repoPath = createTempRepo();

      try {
        const git = new GitCommand(repoPath);
        const result = git.listCommits({ limit: 1 });
        const root = result.commits[0];

        const diff = git.diffCommit(root.id);
        assert.match(diff, /\+base/);
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
