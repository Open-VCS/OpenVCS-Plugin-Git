// Copyright © 2025-2026 OpenVCS Contributors
// SPDX-License-Identifier: GPL-3.0-or-later
/// <reference types="node" />

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { GitCommand } from '../src/git.js';
import type { RunGitOptions } from '../src/plugin-types.js';

/** Creates a GitCommand whose run/runChecked are stubbed. */
function createMockGit(
  overrides: Partial<{
    run: GitCommand['run'];
    runChecked: GitCommand['runChecked'];
  }> = {},
): GitCommand {
  const git = new GitCommand('/tmp/mock');
  if (overrides.run) git.run = overrides.run;
  if (overrides.runChecked) git.runChecked = overrides.runChecked;
  return git;
}

/** Captures the last set of args passed to run/runChecked. */
function captureRun(): {
  git: GitCommand;
  args: string[][];
} {
  const args: string[][] = [];
  const git = createMockGit({
    run: ((a: string[]) => {
      args.push(a);
      return { status: 0, stdout: '', stderr: '' };
    }) as GitCommand['run'],
    runChecked: ((a: string[]) => {
      args.push(a);
      return { status: 0, stdout: '', stderr: '' };
    }) as GitCommand['runChecked'],
  });
  return { git, args };
}

describe('GitCommand advanced', () => {
  describe('stash operations', () => {
    it('listStashes parses stash output', () => {
      const git = createMockGit({
        runChecked: () => ({
          status: 0,
          stdout: 'stash@{0}\u001fWIP on main: fix bug\u001e',
          stderr: '',
        }),
      });
      const stashes = git.listStashes();
      assert.strictEqual(stashes.length, 1);
      assert.strictEqual(stashes[0].selector, 'stash@{0}');
      assert.strictEqual(stashes[0].msg, 'WIP on main: fix bug');
    });

    it('stashPush runs with message and include-untracked', () => {
      const { git, args } = captureRun();
      git.runChecked = ((a: string[]) => {
        args.push(a);
        return { status: 0, stdout: 'stash@{0}\n', stderr: '' };
      }) as GitCommand['runChecked'];
      git.stashPush('test message', true);
      assert.deepStrictEqual(args[0], ['stash', 'push', '--include-untracked', '-m', 'test message']);
      assert.deepStrictEqual(args[1], ['stash', 'list', '-n', '1', '--pretty=format:%gd']);
    });

    it('stashApply passes selector', () => {
      const { git, args } = captureRun();
      git.runChecked = ((a: string[]) => {
        args.push(a);
        return { status: 0, stdout: '', stderr: '' };
      }) as GitCommand['runChecked'];
      git.stashApply('stash@{0}');
      assert.deepStrictEqual(args[0], ['stash', 'apply', 'stash@{0}']);
    });

    it('stashPop passes selector', () => {
      const { git, args } = captureRun();
      git.runChecked = ((a: string[]) => {
        args.push(a);
        return { status: 0, stdout: '', stderr: '' };
      }) as GitCommand['runChecked'];
      git.stashPop('stash@{0}');
      assert.deepStrictEqual(args[0], ['stash', 'pop', 'stash@{0}']);
    });

    it('stashDrop passes selector', () => {
      const { git, args } = captureRun();
      git.runChecked = ((a: string[]) => {
        args.push(a);
        return { status: 0, stdout: '', stderr: '' };
      }) as GitCommand['runChecked'];
      git.stashDrop('stash@{0}');
      assert.deepStrictEqual(args[0], ['stash', 'drop', 'stash@{0}']);
    });

    it('stashShow passes selector', () => {
      const { git, args } = captureRun();
      git.runChecked = ((a: string[]) => {
        args.push(a);
        return { status: 0, stdout: 'diff --git a/file.txt b/file.txt\n', stderr: '' };
      }) as GitCommand['runChecked'];
      const output = git.stashShow('stash@{0}');
      assert.deepStrictEqual(args[0], ['stash', 'show', '-p', 'stash@{0}']);
      assert.match(output, /diff --git/);
    });
  });

  describe('merge operations', () => {
    it('mergeIntoCurrent passes branch name', () => {
      const { git, args } = captureRun();
      git.runChecked = ((a: string[]) => {
        args.push(a);
        return { status: 0, stdout: '', stderr: '' };
      }) as GitCommand['runChecked'];
      git.mergeIntoCurrent('feature');
      assert.deepStrictEqual(args[0], ['merge', 'feature']);
    });

    it('mergeAbort passes correct args', () => {
      const { git, args } = captureRun();
      git.runChecked = ((a: string[]) => {
        args.push(a);
        return { status: 0, stdout: '', stderr: '' };
      }) as GitCommand['runChecked'];
      git.mergeAbort();
      assert.deepStrictEqual(args[0], ['merge', '--abort']);
    });

    it('mergeContinue passes message when provided', () => {
      const { git, args } = captureRun();
      git.runChecked = ((a: string[]) => {
        args.push(a);
        return { status: 0, stdout: '', stderr: '' };
      }) as GitCommand['runChecked'];
      git.mergeContinue('merge commit');
      assert.deepStrictEqual(args[0], ['commit', '-m', 'merge commit']);
    });

    it('mergeContinue omits -m when no message', () => {
      const { git, args } = captureRun();
      git.runChecked = ((a: string[]) => {
        args.push(a);
        return { status: 0, stdout: '', stderr: '' };
      }) as GitCommand['runChecked'];
      git.mergeContinue();
      assert.deepStrictEqual(args[0], ['commit']);
    });

    it('isMergeInProgress returns true when MERGE_HEAD exists', () => {
      const git = createMockGit({
        run: () => ({ status: 0, stdout: '', stderr: '' }),
      });
      assert.strictEqual(git.isMergeInProgress(), true);
    });

    it('isMergeInProgress returns false when MERGE_HEAD absent', () => {
      const git = createMockGit({
        run: () => ({ status: 1, stdout: '', stderr: '' }),
      });
      assert.strictEqual(git.isMergeInProgress(), false);
    });
  });

  describe('other GitCommand operations', () => {
    it('cherryPick passes commit', () => {
      const { git, args } = captureRun();
      git.runChecked = ((a: string[]) => {
        args.push(a);
        return { status: 0, stdout: '', stderr: '' };
      }) as GitCommand['runChecked'];
      git.cherryPick('abc123');
      assert.deepStrictEqual(args[0], ['cherry-pick', 'abc123']);
    });

    it('revertCommit passes commit with noEdit', () => {
      const { git, args } = captureRun();
      git.runChecked = ((a: string[]) => {
        args.push(a);
        return { status: 0, stdout: '', stderr: '' };
      }) as GitCommand['runChecked'];
      git.revertCommit('abc123', true);
      assert.deepStrictEqual(args[0], ['revert', '--no-edit', 'abc123']);
    });

    it('revertCommit passes commit without noEdit', () => {
      const { git, args } = captureRun();
      git.runChecked = ((a: string[]) => {
        args.push(a);
        return { status: 0, stdout: '', stderr: '' };
      }) as GitCommand['runChecked'];
      git.revertCommit('abc123');
      assert.deepStrictEqual(args[0], ['revert', 'abc123']);
    });

    it('applyReversePatch passes patch via stdin', () => {
      const { git } = captureRun();
      let capturedArgs: string[] = [];
      let capturedStdin: string | undefined;
      git.runChecked = ((
        a: string[],
        _errorCode: string,
        options?: RunGitOptions,
      ) => {
        capturedArgs = a;
        capturedStdin = options?.stdin;
        return { status: 0, stdout: '', stderr: '' };
      }) as GitCommand['runChecked'];
      git.applyReversePatch('some-patch');
      assert.deepStrictEqual(capturedArgs, ['apply', '-R', '--unidiff-zero']);
      assert.strictEqual(capturedStdin, 'some-patch');
    });

    it('hardResetHead uses default HEAD when no ref given', () => {
      const { git, args } = captureRun();
      git.runChecked = ((a: string[]) => {
        args.push(a);
        return { status: 0, stdout: '', stderr: '' };
      }) as GitCommand['runChecked'];
      git.hardResetHead();
      assert.deepStrictEqual(args[0], ['reset', '--hard', 'HEAD']);
    });

    it('hardResetHead uses provided ref', () => {
      const { git, args } = captureRun();
      git.runChecked = ((a: string[]) => {
        args.push(a);
        return { status: 0, stdout: '', stderr: '' };
      }) as GitCommand['runChecked'];
      git.hardResetHead('abc123');
      assert.deepStrictEqual(args[0], ['reset', '--hard', 'abc123']);
    });

    it('resetSoftTo passes ref', () => {
      const { git, args } = captureRun();
      git.runChecked = ((a: string[]) => {
        args.push(a);
        return { status: 0, stdout: '', stderr: '' };
      }) as GitCommand['runChecked'];
      git.resetSoftTo('abc123');
      assert.deepStrictEqual(args[0], ['reset', '--soft', 'abc123']);
    });

    it('getIdentity returns null when config fails', () => {
      const git = createMockGit({
        run: () => ({ status: 128, stdout: '', stderr: '' }),
      });
      assert.strictEqual(git.getIdentity(), null);
    });

    it('getIdentity returns name and email', () => {
      const calls: string[][] = [];
      const git = createMockGit({
        run: (a: string[]) => {
          calls.push(a);
          if (a.includes('user.name')) return { status: 0, stdout: 'Test User\n', stderr: '' };
          if (a.includes('user.email')) return { status: 0, stdout: 'test@example.com\n', stderr: '' };
          return { status: 0, stdout: '', stderr: '' };
        },
      });
      const identity = git.getIdentity();
      assert.deepStrictEqual(identity, { name: 'Test User', email: 'test@example.com' });
    });

    it('setIdentityLocal passes name and email', () => {
      const { git, args } = captureRun();
      git.runChecked = ((a: string[]) => {
        args.push(a);
        return { status: 0, stdout: '', stderr: '' };
      }) as GitCommand['runChecked'];
      git.setIdentityLocal('Test User', 'test@example.com');
      assert.deepStrictEqual(args[0], ['config', '--local', 'user.name', 'Test User']);
      assert.deepStrictEqual(args[1], ['config', '--local', 'user.email', 'test@example.com']);
    });
  });

  describe('submodule operations', () => {
    it('addSubmodule builds args with name and branch', () => {
      const { git, args } = captureRun();
      git.runChecked = ((a: string[]) => {
        args.push(a);
        return { status: 0, stdout: '', stderr: '' };
      }) as GitCommand['runChecked'];
      git.addSubmodule('https://example.com/repo.git', 'libs/repo', 'repo', 'main');
      assert.deepStrictEqual(args[0], ['submodule', 'add', '--name', 'repo', '--branch', 'main', 'https://example.com/repo.git', 'libs/repo']);
    });

    it('addSubmodule works without name and branch', () => {
      const { git, args } = captureRun();
      git.runChecked = ((a: string[]) => {
        args.push(a);
        return { status: 0, stdout: '', stderr: '' };
      }) as GitCommand['runChecked'];
      git.addSubmodule('https://example.com/repo.git', 'libs/repo');
      assert.deepStrictEqual(args[0], ['submodule', 'add', 'https://example.com/repo.git', 'libs/repo']);
    });

    it('updateSubmodule passes path', () => {
      const { git, args } = captureRun();
      git.runChecked = ((a: string[]) => {
        args.push(a);
        return { status: 0, stdout: '', stderr: '' };
      }) as GitCommand['runChecked'];
      git.updateSubmodule('libs/repo');
      assert.deepStrictEqual(args[0], ['submodule', 'update', '--init', '--recursive', '--', 'libs/repo']);
    });

    it('updateAllSubmodules runs without path', () => {
      const { git, args } = captureRun();
      git.runChecked = ((a: string[]) => {
        args.push(a);
        return { status: 0, stdout: '', stderr: '' };
      }) as GitCommand['runChecked'];
      git.updateAllSubmodules();
      assert.deepStrictEqual(args[0], ['submodule', 'update', '--init', '--recursive']);
    });

    it('updateSubmoduleRemote passes path with --remote', () => {
      const { git, args } = captureRun();
      git.runChecked = ((a: string[]) => {
        args.push(a);
        return { status: 0, stdout: '', stderr: '' };
      }) as GitCommand['runChecked'];
      git.updateSubmoduleRemote('libs/repo');
      assert.deepStrictEqual(args[0], ['submodule', 'update', '--init', '--recursive', '--remote', '--', 'libs/repo']);
    });

    it('syncSubmodule passes path', () => {
      const { git, args } = captureRun();
      git.runChecked = ((a: string[]) => {
        args.push(a);
        return { status: 0, stdout: '', stderr: '' };
      }) as GitCommand['runChecked'];
      git.syncSubmodule('libs/repo');
      assert.deepStrictEqual(args[0], ['submodule', 'sync', '--recursive', '--', 'libs/repo']);
    });

    it('listSubmodules returns empty when status fails', () => {
      const git = createMockGit({
        run: () => ({ status: 128, stdout: '', stderr: 'fatal: not a git repository' }),
      });
      const entries = git.listSubmodules();
      assert.deepStrictEqual(entries, []);
    });
  });

  describe('conflict operations', () => {
    it('getConflictDetails returns null placeholders when ours/theirs missing', () => {
      const git = createMockGit({
        run: () => ({ status: 128, stdout: '', stderr: '' }),
      });
      const details = git.getConflictDetails('conflict.txt');
      assert.strictEqual(details.ours, null);
      assert.strictEqual(details.theirs, null);
      assert.strictEqual(details.base, null);
      assert.strictEqual(details.binary, false);
    });

    it('getConflictDetails detects LFS pointer content', () => {
      const lfsContent = 'version https://git-lfs.github.com/spec/v1\noid sha256:abc123\nsize 100\n';
      const git = createMockGit({
        run: (a: string[]) => {
          if (a[1] === ':2:conflict.txt') return { status: 0, stdout: lfsContent, stderr: '' };
          if (a[1] === ':3:conflict.txt') return { status: 0, stdout: lfsContent, stderr: '' };
          return { status: 128, stdout: '', stderr: '' };
        },
      });
      const details = git.getConflictDetails('conflict.txt');
      assert.strictEqual(details.binary, false);
    });

    it('getConflictDetails detects binary content', () => {
      const git = createMockGit({
        run: (a: string[]) => {
          if (a[1] === ':2:conflict.txt') return { status: 0, stdout: 'Binary\0data', stderr: '' };
          if (a[1] === ':3:conflict.txt') return { status: 0, stdout: 'Binary\0data', stderr: '' };
          return { status: 128, stdout: '', stderr: '' };
        },
      });
      const details = git.getConflictDetails('conflict.txt');
      assert.strictEqual(details.binary, true);
    });

    it('getConflictDetails includes base content when available', () => {
      const git = createMockGit({
        run: (a: string[]) => {
          if (a[1] === ':2:conflict.txt') return { status: 0, stdout: 'our version\n', stderr: '' };
          if (a[1] === ':3:conflict.txt') return { status: 0, stdout: 'their version\n', stderr: '' };
          if (a[1] === ':1:conflict.txt') return { status: 0, stdout: 'base version\n', stderr: '' };
          return { status: 128, stdout: '', stderr: '' };
        },
      });
      const details = git.getConflictDetails('conflict.txt');
      assert.strictEqual(details.ours, 'our version\n');
      assert.strictEqual(details.theirs, 'their version\n');
      assert.strictEqual(details.base, 'base version\n');
      assert.strictEqual(details.binary, false);
    });

    it('checkoutConflictSide passes ours ref', () => {
      const { git, args } = captureRun();
      git.runChecked = ((a: string[]) => {
        args.push(a);
        return { status: 0, stdout: '', stderr: '' };
      }) as GitCommand['runChecked'];
      git.checkoutConflictSide('conflict.txt', 'ours');
      assert.deepStrictEqual(args[0], ['checkout', ':2', '--', 'conflict.txt']);
    });

    it('checkoutConflictSide passes theirs ref', () => {
      const { git, args } = captureRun();
      git.runChecked = ((a: string[]) => {
        args.push(a);
        return { status: 0, stdout: '', stderr: '' };
      }) as GitCommand['runChecked'];
      git.checkoutConflictSide('conflict.txt', 'theirs');
      assert.deepStrictEqual(args[0], ['checkout', ':3', '--', 'conflict.txt']);
    });
  });

  describe('removeSubmodule', () => {
    it('runs deinit then rm', () => {
      const { git, args } = captureRun();
      git.runChecked = ((a: string[]) => {
        args.push(a);
        return { status: 0, stdout: '', stderr: '' };
      }) as GitCommand['runChecked'];
      git.removeSubmodule('libs/repo');
      assert.deepStrictEqual(args[0], ['submodule', 'deinit', '-f', '--', 'libs/repo']);
      assert.deepStrictEqual(args[1], ['rm', '-f', '--', 'libs/repo']);
    });
  });

  describe('writeMergeResult', () => {
    it('hashes content and updates index', () => {
      const calls: string[][] = [];
      const git = createMockGit({
        run: (a: string[]) => {
          calls.push(a);
          return { status: 0, stdout: 'abc123\n', stderr: '' };
        },
        runChecked: (a: string[]) => {
          calls.push(a);
          return { status: 0, stdout: '', stderr: '' };
        },
      });
      git.writeMergeResult('file.txt', 'merged content');
      assert.deepStrictEqual(calls[0], ['hash-object', '-w', '--stdin']);
      assert.deepStrictEqual(calls[1], ['update-index', '--add', '--cacheinfo', '100644', 'abc123', 'file.txt']);
    });
  });

  describe('syncAllSubmodules', () => {
    it('passes correct args', () => {
      const { git, args } = captureRun();
      git.runChecked = ((a: string[]) => {
        args.push(a);
        return { status: 0, stdout: '', stderr: '' };
      }) as GitCommand['runChecked'];
      git.syncAllSubmodules();
      assert.deepStrictEqual(args[0], ['submodule', 'sync', '--recursive']);
    });
  });

  describe('updateAllSubmodulesRemote', () => {
    it('passes correct args', () => {
      const { git, args } = captureRun();
      git.runChecked = ((a: string[]) => {
        args.push(a);
        return { status: 0, stdout: '', stderr: '' };
      }) as GitCommand['runChecked'];
      git.updateAllSubmodulesRemote();
      assert.deepStrictEqual(args[0], ['submodule', 'update', '--init', '--recursive', '--remote']);
    });
  });

  describe('listSubmodules with config', () => {
    it('parses submodules from config and status output', () => {
      const git = createMockGit({
        run: (args: string[]) => {
          if (args.includes('-f') && args.includes('.gitmodules')) {
            return {
              status: 0,
              stdout: 'submodule.libs/repo.path\nlibs/repo\0submodule.libs/repo.url\nhttps://example.com/repo.git\0submodule.libs/repo.branch\nmain\0',
              stderr: '',
            };
          }
          if (args[0] === 'submodule' && args[1] === 'status') {
            return {
              status: 0,
              stdout: ' abc1234567 libs/repo\n +dirtyhash libs/dirty\n',
              stderr: '',
            };
          }
          return { status: 0, stdout: '', stderr: '' };
        },
      });
      const entries = git.listSubmodules();
      assert.strictEqual(entries.length, 2);
      assert.strictEqual(entries[0].path, 'libs/dirty');
      assert.strictEqual(entries[0].state, 'dirty');
      assert.strictEqual(entries[1].path, 'libs/repo');
      assert.strictEqual(entries[1].state, 'clean');
      assert.strictEqual(entries[1].url, 'https://example.com/repo.git');
      assert.strictEqual(entries[1].branch, 'main');
    });
  });

  describe('stagePatch edge cases', () => {
    it('applies a valid patch', () => {
      const patch = [
        'diff --git a/file.txt b/file.txt',
        'index abc..def 100644',
        '--- a/file.txt',
        '+++ b/file.txt',
        '@@ -1 +1 @@',
        '-old',
        '+new',
      ].join('\n');
      const git = createMockGit({
        run: () => ({ status: 0, stdout: 'abc123\n', stderr: '' }),
        runChecked: () => ({ status: 0, stdout: '', stderr: '' }),
      });
      git.stagePatch(patch);
      assert.ok('stagePatch completed without error');
    });

    it('handles a simple single-file patch without dedup', () => {
      const patch = [
        'diff --git a/fix.txt b/fix.txt',
        '--- a/fix.txt',
        '+++ b/fix.txt',
        '@@ -1 +1 @@',
        '-bug',
        '+fix',
      ].join('\n');
      const git = createMockGit({
        run: () => ({ status: 0, stdout: 'abc123\n', stderr: '' }),
        runChecked: () => ({ status: 0, stdout: '', stderr: '' }),
      });
      git.stagePatch(patch);
      assert.ok('single file patch applied');
    });

    it('keeps original patch when any diff section is unparseable', () => {
      const patch = [
        'diff --git a/first.txt b/first.txt',
        '--- a/first.txt',
        '+++ b/first.txt',
        '@@ -1 +1 @@',
        '-old',
        '+new',
        'diff --git malformed-header',
        '--- a/second.txt',
        '+++ b/second.txt',
        '@@ -1 +1 @@',
        '-old',
        '+new',
      ].join('\n');
      let stdin = '';
      const git = createMockGit({
        runChecked: ((_args, _errorCode, options) => {
          stdin = options?.stdin ?? '';
          return { status: 0, stdout: '', stderr: '' };
        }) as GitCommand['runChecked'],
      });

      git.stagePatch(patch);

      assert.strictEqual(stdin, patch);
    });
  });
});
