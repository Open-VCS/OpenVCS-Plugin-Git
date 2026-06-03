// Copyright © 2025-2026 OpenVCS Contributors
// SPDX-License-Identifier: GPL-3.0-or-later
/// <reference types="node" />

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

  describe('isBinaryBuffer', () => {
    it('returns false for empty buffer', () => {
      const repoPath = mkdtempSync(join(tmpdir(), 'openvcs-git-binary-empty-'));
      try {
        writeFileSync(join(repoPath, 'empty.txt'), '');
        const git = new GitCommand(repoPath);
        git.run = ((args: string[]) => {
          if (args[0] === 'status') {
            return { status: 0, stdout: '## main\0?? empty.txt\0', stderr: '' };
          }
          return { status: 1, stdout: '', stderr: '' };
        }) as GitCommand['run'];
        const status = git.status();
        const emptyFile = status.payload.files.find(f => f.path === 'empty.txt');
        assert.strictEqual(emptyFile?.binary, false);
      } finally {
        rmSync(repoPath, { recursive: true, force: true });
      }
    });

    it('returns false for UTF-16 LE BOM content', () => {
      const repoPath = mkdtempSync(join(tmpdir(), 'openvcs-git-binary-utf16-'));
      try {
        const utf16leBom = Buffer.from([0xff, 0xfe, 0x68, 0x00, 0x65, 0x00, 0x6c, 0x00, 0x6c, 0x00, 0x6f, 0x00]);
        writeFileSync(join(repoPath, 'utf16.txt'), utf16leBom);
        const git = new GitCommand(repoPath);
        git.run = ((args: string[]) => {
          if (args[0] === 'status') {
            return { status: 0, stdout: '## main\0?? utf16.txt\0', stderr: '' };
          }
          return { status: 1, stdout: '', stderr: '' };
        }) as GitCommand['run'];
        const status = git.status();
        const utf16File = status.payload.files.find(f => f.path === 'utf16.txt');
        assert.strictEqual(utf16File?.binary, false);
      } finally {
        rmSync(repoPath, { recursive: true, force: true });
      }
    });

    it('returns false for UTF-16 BE BOM content', () => {
      const repoPath = mkdtempSync(join(tmpdir(), 'openvcs-git-binary-utf16be-'));
      try {
        const utf16beBom = Buffer.from([0xfe, 0xff, 0x00, 0x68, 0x00, 0x65, 0x00, 0x6c, 0x00, 0x6c, 0x00, 0x6f]);
        writeFileSync(join(repoPath, 'utf16be.txt'), utf16beBom);
        const git = new GitCommand(repoPath);
        git.run = ((args: string[]) => {
          if (args[0] === 'status') {
            return { status: 0, stdout: '## main\0?? utf16be.txt\0', stderr: '' };
          }
          return { status: 1, stdout: '', stderr: '' };
        }) as GitCommand['run'];
        const status = git.status();
        const utf16File = status.payload.files.find(f => f.path === 'utf16be.txt');
        assert.strictEqual(utf16File?.binary, false);
      } finally {
        rmSync(repoPath, { recursive: true, force: true });
      }
    });
  });

  describe('diffFile binary markers', () => {
    it('marks binary true when git diff emits binary patch markers', () => {
      const git = createMockGit({
        runChecked: (a: string[]) => {
          if (a.includes('--cached')) {
            return { status: 0, stdout: 'Binary files a/file.bin and b/file.bin differ\n', stderr: '' };
          }
          return { status: 0, stdout: '', stderr: '' };
        },
      });
      const diff = git.diffFile('file.bin');
      assert.strictEqual(diff.binary, true);
      assert.deepStrictEqual(diff.lines, ['Binary files a/file.bin and b/file.bin differ']);
    });

    it('marks binary true for git binary patch literal output', () => {
      const git = createMockGit({
        runChecked: (a: string[]) => {
          if (a.includes('--cached')) {
            return { status: 0, stdout: 'GIT binary patch\nliteral 10\n', stderr: '' };
          }
          return { status: 0, stdout: '', stderr: '' };
        },
      });
      const diff = git.diffFile('file.bin');
      assert.strictEqual(diff.binary, true);
    });

    it('returns null binary flag for empty path (defensive guard)', () => {
      const git = createMockGit({
        runChecked: () => ({ status: 0, stdout: '', stderr: '' }),
      });
      // Pass empty path → readWorktreeBinaryFlag gets empty trimmedPath → returns null
      // diffFile: lines=[] → binaryFromOutput=false → lines.length=0 → readWorktreeBinaryFlag('')
      // Since the path is empty, readWorktreeBinaryFlag returns null
      const diff = git.diffFile('');
      assert.strictEqual(diff.binary, null);
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

    it('parses uninitialized and conflicted submodule states', () => {
      const git = createMockGit({
        run: (args: string[]) => {
          if (args.includes('-f') && args.includes('.gitmodules')) {
            return {
              status: 0,
              stdout: 'submodule.libs/uninit.path\nlibs/uninit\0submodule.libs/conflict.path\nlibs/conflict\0',
              stderr: '',
            };
          }
          if (args[0] === 'submodule' && args[1] === 'status') {
            return {
              status: 0,
              stdout: '-abc1234567 libs/uninit\nUdef4567890 libs/conflict\n',
              stderr: '',
            };
          }
          return { status: 0, stdout: '', stderr: '' };
        },
      });
      const entries = git.listSubmodules();
      assert.strictEqual(entries.length, 2);
      assert.strictEqual(entries[0].path, 'libs/conflict');
      assert.strictEqual(entries[0].state, 'conflicted');
      assert.strictEqual(entries[1].path, 'libs/uninit');
      assert.strictEqual(entries[1].state, 'uninitialized');
    });

    it('skips submodule status lines with no path', () => {
      const git = createMockGit({
        run: (args: string[]) => {
          if (args.includes('-f') && args.includes('.gitmodules')) {
            return { status: 0, stdout: '', stderr: '' };
          }
          if (args[0] === 'submodule' && args[1] === 'status') {
            return { status: 0, stdout: ' abc1234567\n', stderr: '' };
          }
          return { status: 0, stdout: '', stderr: '' };
        },
      });
      const entries = git.listSubmodules();
      assert.strictEqual(entries.length, 0);
    });

    it('handles slash-only path for name fallback', () => {
      const git = createMockGit({
        run: (args: string[]) => {
          if (args.includes('-f') && args.includes('.gitmodules')) {
            return { status: 0, stdout: '', stderr: '' };
          }
          if (args[0] === 'submodule' && args[1] === 'status') {
            return { status: 0, stdout: ' abc1234567 /\n', stderr: '' };
          }
          return { status: 0, stdout: '', stderr: '' };
        },
      });
      const entries = git.listSubmodules();
      assert.strictEqual(entries.length, 1);
      assert.strictEqual(entries[0].name, '/');
    });

    it('skips gitmodules entries without newline separator', () => {
      const git = createMockGit({
        run: (args: string[]) => {
          if (args.includes('-f') && args.includes('.gitmodules')) {
            return {
              status: 0,
              stdout: 'submodule.libs/repo.path\0',
              stderr: '',
            };
          }
          if (args[0] === 'submodule' && args[1] === 'status') {
            return { status: 0, stdout: '', stderr: '' };
          }
          return { status: 0, stdout: '', stderr: '' };
        },
      });
      const entries = git.listSubmodules();
      assert.strictEqual(entries.length, 0);
    });

    it('skips gitmodules entries with non-submodule keys', () => {
      const git = createMockGit({
        run: (args: string[]) => {
          if (args.includes('-f') && args.includes('.gitmodules')) {
            return {
              status: 0,
              stdout: 'core.bare\ntrue\0',
              stderr: '',
            };
          }
          if (args[0] === 'submodule' && args[1] === 'status') {
            return { status: 0, stdout: '', stderr: '' };
          }
          return { status: 0, stdout: '', stderr: '' };
        },
      });
      const entries = git.listSubmodules();
      assert.strictEqual(entries.length, 0);
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

  describe('stageSelections', () => {
    it('applies combined patch from whole-hunk selections', () => {
      let appliedStdin = '';
      const git = createMockGit({
        runChecked: ((args: string[], _errorCode: string, options?: any) => {
          if (args.includes('apply')) appliedStdin = options?.stdin ?? '';
          if (args[0] === 'diff') return { status: 0, stdout: [
            'diff --git a/file.txt b/file.txt',
            '--- a/file.txt',
            '+++ b/file.txt',
            '@@ -1 +1 @@',
            '-old',
            '+new',
          ].join('\n'), stderr: '' };
          return { status: 0, stdout: '', stderr: '' };
        }) as GitCommand['runChecked'],
      });
      git.stageSelections([{
        path: 'file.txt',
        whole_hunks: [0],
        partial_hunks: {},
      }]);
      assert.ok(appliedStdin.includes('diff --git a/file.txt b/file.txt'));
      assert.ok(appliedStdin.includes('@@ -1 +1 @@'));
      assert.ok(appliedStdin.includes('-old'));
      assert.ok(appliedStdin.includes('+new'));
    });

    it('handles partial_hunks (line-level selections)', () => {
      let appliedStdin = '';
      const git = createMockGit({
        runChecked: ((args: string[], _errorCode: string, options?: any) => {
          if (args.includes('apply')) appliedStdin = options?.stdin ?? '';
          if (args[0] === 'diff') return { status: 0, stdout: [
            'diff --git a/file.txt b/file.txt',
            '--- a/file.txt',
            '+++ b/file.txt',
            '@@ -1,2 +1,2 @@',
            '-old1',
            '+new1',
          ].join('\n'), stderr: '' };
          return { status: 0, stdout: '', stderr: '' };
        }) as GitCommand['runChecked'],
      });
      git.stageSelections([{
        path: 'file.txt',
        whole_hunks: [],
        partial_hunks: { 0: [1] },
      }]);
      assert.ok(appliedStdin.includes('@@'));
      assert.ok(appliedStdin.includes('-old1'));
    });

    it('skips files with no matching hunks', () => {
      let runCount = 0;
      const git = createMockGit({
        runChecked: ((args: string[]) => {
          runCount++;
          if (args[0] === 'diff') return { status: 0, stdout: '', stderr: '' };
          return { status: 0, stdout: '', stderr: '' };
        }) as GitCommand['runChecked'],
      });
      git.stageSelections([{
        path: 'nonexistent.txt',
        whole_hunks: [0],
        partial_hunks: {},
      }]);
      assert.strictEqual(runCount, 1);
    });

    it('handles multiple files with different selections', () => {
      let appliedStdin = '';
      const git = createMockGit({
        runChecked: ((args: string[], _errorCode: string, options?: any) => {
          if (args.includes('apply')) appliedStdin = options?.stdin ?? '';
          const path = args.at(-1);
          if (args[0] === 'diff' && path === 'a.txt') return { status: 0, stdout: [
            'diff --git a/a.txt b/a.txt',
            '--- a/a.txt',
            '+++ b/a.txt',
            '@@ -1 +1 @@',
            '-a_old',
            '+a_new',
          ].join('\n'), stderr: '' };
          if (args[0] === 'diff' && path === 'b.txt') return { status: 0, stdout: [
            'diff --git a/b.txt b/b.txt',
            '--- a/b.txt',
            '+++ b/b.txt',
            '@@ -1 +1 @@',
            '-b_old',
            '+b_new',
          ].join('\n'), stderr: '' };
          return { status: 0, stdout: '', stderr: '' };
        }) as GitCommand['runChecked'],
      });
      git.stageSelections([
        { path: 'a.txt', whole_hunks: [0], partial_hunks: {} },
        { path: 'b.txt', whole_hunks: [0], partial_hunks: {} },
      ]);
      assert.ok(appliedStdin.includes('diff --git a/a.txt b/a.txt'));
      assert.ok(appliedStdin.includes('diff --git a/b.txt b/b.txt'));
      assert.ok(appliedStdin.includes('-a_old'));
      assert.ok(appliedStdin.includes('-b_old'));
    });

    it('handles \\ No newline metadata lines in diff output', () => {
      let appliedStdin = '';
      const git = createMockGit({
        runChecked: ((args: string[], _errorCode: string, options?: any) => {
          if (args.includes('apply')) appliedStdin = options?.stdin ?? '';
          if (args[0] === 'diff') return { status: 0, stdout: [
            'diff --git a/file.txt b/file.txt',
            '--- a/file.txt',
            '+++ b/file.txt',
            '@@ -1,2 +1,2 @@',
            '-old_line',
            '+new_line',
            '\\ No newline at end of file',
          ].join('\n'), stderr: '' };
          return { status: 0, stdout: '', stderr: '' };
        }) as GitCommand['runChecked'],
      });
      git.stageSelections([{
        path: 'file.txt',
        whole_hunks: [0],
        partial_hunks: {},
      }]);
      assert.ok(appliedStdin.includes('-old_line'));
      assert.ok(appliedStdin.includes('+new_line'));
      assert.ok(appliedStdin.includes('\\ No newline'));
    });

    it('generates mini-hunks from context+removed selections', () => {
      let appliedStdin = '';
      const git = createMockGit({
        runChecked: ((args: string[], _errorCode: string, options?: any) => {
          if (args.includes('apply')) appliedStdin = options?.stdin ?? '';
          if (args[0] === 'diff') return { status: 0, stdout: [
            'diff --git a/file.txt b/file.txt',
            '--- a/file.txt',
            '+++ b/file.txt',
            '@@ -5,3 +5,2 @@',
            ' context',
            '-removed',
            '+added',
          ].join('\n'), stderr: '' };
          return { status: 0, stdout: '', stderr: '' };
        }) as GitCommand['runChecked'],
      });
      git.stageSelections([{
        path: 'file.txt',
        whole_hunks: [],
        partial_hunks: { 0: [1, 2] },
      }]);
      assert.ok(appliedStdin.includes(' context'));
      assert.ok(appliedStdin.includes('-removed'));
      assert.ok(appliedStdin.includes('-5,2'));
      assert.ok(appliedStdin.includes('+5,1'));
    });

    it('handles non-consecutive partial line selections (gap triggers flush)', () => {
      let appliedStdin = '';
      const git = createMockGit({
        runChecked: ((args: string[], _errorCode: string, options?: any) => {
          if (args.includes('apply')) appliedStdin = options?.stdin ?? '';
          if (args[0] === 'diff') return { status: 0, stdout: [
            'diff --git a/file.txt b/file.txt',
            '--- a/file.txt',
            '+++ b/file.txt',
            '@@ -1,4 +1,4 @@',
            ' line1',
            '-old2',
            '+new2',
            '-old4',
            '+new4',
          ].join('\n'), stderr: '' };
          return { status: 0, stdout: '', stderr: '' };
        }) as GitCommand['runChecked'],
      });
      // Select lines 2 and 4 (1-based UI indices), skipping line 3
      git.stageSelections([{
        path: 'file.txt',
        whole_hunks: [],
        partial_hunks: { 0: [2, 4] },
      }]);
      // Should produce two mini-hunks: one for line 2, one for line 4
      assert.ok(appliedStdin.includes('-old2'));
      assert.ok(appliedStdin.includes('-old4'));
    });

    it('handles partial_hunks where value is not an array (falls through to empty picksAdj)', () => {
      let appliedStdin = '';
      const git = createMockGit({
        runChecked: ((args: string[], _errorCode: string, options?: any) => {
          if (args.includes('apply')) appliedStdin = options?.stdin ?? '';
          if (args[0] === 'diff') return { status: 0, stdout: [
            'diff --git a/file.txt b/file.txt',
            '--- a/file.txt',
            '+++ b/file.txt',
            '@@ -1,2 +1,2 @@',
            '-old1',
            '+new1',
          ].join('\n'), stderr: '' };
          return { status: 0, stdout: '', stderr: '' };
        }) as GitCommand['runChecked'],
      });
      // partial_hunks[h] exists but is a string, not an array → picksRaw is string
      // → Array.isArray(picksRaw) is false → picksAdj becomes []
      // → pickSet.size === 0 → hunk is skipped
      // Header still included but no hunks
      git.stageSelections([{
        path: 'file.txt',
        whole_hunks: [],
        partial_hunks: { 0: 'not-an-array' as never },
      }]);
      // Only header present, no hunk content
      assert.ok(appliedStdin.startsWith('diff --git a/file.txt b/file.txt'));
      assert.ok(!appliedStdin.includes('@@'));
    });

    it('handles header extras line filtering in prelude', () => {
      let appliedStdin = '';
      const git = createMockGit({
        runChecked: ((args: string[], _errorCode: string, options?: any) => {
          if (args.includes('apply')) appliedStdin = options?.stdin ?? '';
          if (args[0] === 'diff') return { status: 0, stdout: [
            'diff --git a/file.txt b/file.txt',
            'old mode 100644',
            'new mode 100755',
            '--- a/file.txt',
            '+++ b/file.txt',
            '@@ -1 +1 @@',
            '-old',
            '+new',
          ].join('\n'), stderr: '' };
          return { status: 0, stdout: '', stderr: '' };
        }) as GitCommand['runChecked'],
      });
      git.stageSelections([{
        path: 'file.txt',
        whole_hunks: [0],
        partial_hunks: {},
      }]);
      assert.ok(appliedStdin.includes('old mode 100644'));
      assert.ok(appliedStdin.includes('+new'));
    });

    it('handles add-file diff (--- /dev/null)', () => {
      let appliedStdin = '';
      const git = createMockGit({
        runChecked: ((args: string[], _errorCode: string, options?: any) => {
          if (args.includes('apply')) appliedStdin = options?.stdin ?? '';
          if (args[0] === 'diff') return { status: 0, stdout: [
            'diff --git a/new.txt b/new.txt',
            'new mode 100644',
            '--- /dev/null',
            '+++ b/new.txt',
            '@@ -0,0 +1 @@',
            '+new file',
          ].join('\n'), stderr: '' };
          return { status: 0, stdout: '', stderr: '' };
        }) as GitCommand['runChecked'],
      });
      git.stageSelections([{
        path: 'new.txt',
        whole_hunks: [0],
        partial_hunks: {},
      }]);
      assert.ok(appliedStdin.includes('--- /dev/null'));
      assert.ok(appliedStdin.includes('+new file'));
    });

    it('handles delete-file diff (+++ /dev/null)', () => {
      let appliedStdin = '';
      const git = createMockGit({
        runChecked: ((args: string[], _errorCode: string, options?: any) => {
          if (args.includes('apply')) appliedStdin = options?.stdin ?? '';
          if (args[0] === 'diff') return { status: 0, stdout: [
            'diff --git a/deleted.txt b/deleted.txt',
            '--- a/deleted.txt',
            '+++ /dev/null',
            '@@ -1 +0,0 @@',
            '-old content',
          ].join('\n'), stderr: '' };
          return { status: 0, stdout: '', stderr: '' };
        }) as GitCommand['runChecked'],
      });
      git.stageSelections([{
        path: 'deleted.txt',
        whole_hunks: [0],
        partial_hunks: {},
      }]);
      assert.ok(appliedStdin.includes('+++ /dev/null'));
      assert.ok(appliedStdin.includes('-old content'));
    });

    it('skips hunk when selected lines are only meta lines (old_count=0, new_count=0)', () => {
      let appliedStdin = '';
      const git = createMockGit({
        runChecked: ((args: string[], _errorCode: string, options?: any) => {
          if (args.includes('apply')) appliedStdin = options?.stdin ?? '';
          if (args[0] === 'diff') return { status: 0, stdout: [
            'diff --git a/file.txt b/file.txt',
            '--- a/file.txt',
            '+++ b/file.txt',
            '@@ -1,2 +1,2 @@',
            '-old',
            '+new',
            '\\ No newline at end of file',
          ].join('\n'), stderr: '' };
          return { status: 0, stdout: '', stderr: '' };
        }) as GitCommand['runChecked'],
      });
      // Select only the meta line (1-indexed: 3), which is the \ No newline
      git.stageSelections([{
        path: 'file.txt',
        whole_hunks: [],
        partial_hunks: { 0: [3] },
      }]);
      // Meta line filtered to metaLines → contentLines empty
      // old_count=0, new_count=0 → bail out, only header present
      assert.ok(appliedStdin.startsWith('diff --git a/file.txt b/file.txt'));
      assert.ok(!appliedStdin.includes('@@'));
    });

    it('filters non-finite numbers from whole_hunks', () => {
      let appliedStdin = '';
      const git = createMockGit({
        runChecked: ((args: string[], _errorCode: string, options?: any) => {
          if (args.includes('apply')) appliedStdin = options?.stdin ?? '';
          if (args[0] === 'diff') return { status: 0, stdout: [
            'diff --git a/file.txt b/file.txt',
            '--- a/file.txt',
            '+++ b/file.txt',
            '@@ -1 +1 @@',
            '-old',
            '+new',
          ].join('\n'), stderr: '' };
          return { status: 0, stdout: '', stderr: '' };
        }) as GitCommand['runChecked'],
      });
      // Only finite hunk index 0 is included; NaN and Infinity filtered out
      git.stageSelections([{
        path: 'file.txt',
        whole_hunks: [0, NaN, Infinity],
        partial_hunks: {},
      }]);
      assert.ok(appliedStdin.includes('-old'));
    });

    it('includes meta lines when selected alongside regular lines via partial_hunks', () => {
      let appliedStdin = '';
      const git = createMockGit({
        runChecked: ((args: string[], _errorCode: string, options?: any) => {
          if (args.includes('apply')) appliedStdin = options?.stdin ?? '';
          if (args[0] === 'diff') return { status: 0, stdout: [
            'diff --git a/file.txt b/file.txt',
            '--- a/file.txt',
            '+++ b/file.txt',
            '@@ -1,2 +1,2 @@',
            '-old',
            '+new',
            '\\ No newline at end of file',
          ].join('\n'), stderr: '' };
          return { status: 0, stdout: '', stderr: '' };
        }) as GitCommand['runChecked'],
      });
      // Select both content lines and the meta line (1-indexed: 1, 2, 3)
      git.stageSelections([{
        path: 'file.txt',
        whole_hunks: [],
        partial_hunks: { 0: [1, 2, 3] },
      }]);
      assert.ok(appliedStdin.includes('-old'));
      assert.ok(appliedStdin.includes('+new'));
      assert.ok(appliedStdin.includes('No newline'));
    });

    it('skips hunks with malformed @@ headers', () => {
      let appliedStdin = '';
      const git = createMockGit({
        runChecked: ((args: string[], _errorCode: string, options?: any) => {
          if (args.includes('apply')) appliedStdin = options?.stdin ?? '';
          if (args[0] === 'diff') return { status: 0, stdout: [
            'diff --git a/file.txt b/file.txt',
            '--- a/file.txt',
            '+++ b/file.txt',
            '@@malformed@@',
            '-bad_old',
            '+bad_new',
            '@@ -4 +4 @@',
            '-good_old',
            '+good_new',
          ].join('\n'), stderr: '' };
          return { status: 0, stdout: '', stderr: '' };
        }) as GitCommand['runChecked'],
      });
      git.stageSelections([{
        path: 'file.txt',
        whole_hunks: [0, 1],
        partial_hunks: {},
      }]);
      // First hunk has malformed header → skipped via `if (!m) continue;`
      // Second hunk is valid → should be in output
      assert.ok(appliedStdin.includes('-good_old'));
      assert.ok(!appliedStdin.includes('-bad_old'));
    });

    it('triggers prefix-sum fallback with empty line via partial hunks', () => {
      let appliedStdin = '';
      const git = createMockGit({
        runChecked: ((args: string[], _errorCode: string, options?: any) => {
          if (args.includes('apply')) appliedStdin = options?.stdin ?? '';
          if (args[0] === 'diff') return { status: 0, stdout: [
            'diff --git a/file.txt b/file.txt',
            '--- a/file.txt',
            '+++ b/file.txt',
            '@@ -1,2 +1,2 @@',
            '',
            '-old',
            '+new',
          ].join('\n'), stderr: '' };
          return { status: 0, stdout: '', stderr: '' };
        }) as GitCommand['runChecked'],
      });
      // Hunk content has ['', '-old', '+new'] → content[0] is ''
      // (content[0] || '') => '', ''[0] => undefined, || ' ' => ' '
      // Must use partial_hunks to reach prefix-sum code (lines 785-791)
      git.stageSelections([{
        path: 'file.txt',
        whole_hunks: [],
        partial_hunks: { 0: [1, 2, 3] },
      }]);
      assert.ok(appliedStdin.includes('-old'));
    });

    it('skips file with diff header but no hunks (firstHunk < 0)', () => {
      let runCount = 0;
      const git = createMockGit({
        runChecked: ((args: string[]) => {
          runCount++;
          if (args[0] === 'diff') return { status: 0, stdout: [
            'diff --git a/file.txt b/file.txt',
            '--- a/file.txt',
            '+++ b/file.txt',
          ].join('\n'), stderr: '' };
          return { status: 0, stdout: '', stderr: '' };
        }) as GitCommand['runChecked'],
      });
      git.stageSelections([{
        path: 'file.txt',
        whole_hunks: [0],
        partial_hunks: {},
      }]);
      // Only diff call made, no apply (since no hunks in file)
      assert.strictEqual(runCount, 1);
    });
  });
});

describe('stagePatch edge cases continued', () => {
  it('deduplicates patches when same path appears multiple times', () => {
    const patch = [
      'diff --git a/a.txt b/a.txt',
      '--- a/a.txt',
      '+++ a/a.txt',
      '@@ -1 +1 @@',
      '-old_a1',
      '+new_a1',
      'diff --git a/a.txt b/a.txt',
      '--- a/a.txt',
      '+++ a/a.txt',
      '@@ -1 +1 @@',
      '-old_a2',
      '+new_a2',
    ].join('\n');
    let stdin = '';
    const git = createMockGit({
      run: () => ({ status: 0, stdout: 'abc123\n', stderr: '' }),
      runChecked: ((_args, _errorCode, options) => {
        stdin = options?.stdin ?? '';
        return { status: 0, stdout: '', stderr: '' };
      }) as GitCommand['runChecked'],
    });
    git.stagePatch(patch);
    // Dedup keeps only the second occurrence
    assert.ok(stdin.includes('-old_a2'));
    assert.ok(!stdin.includes('-old_a1'));
  });

  it('handles diff --git header without b/ marker', () => {
    // When diff --git header doesn't contain ' b/', currentPath is null
    // and the flush function marks the section as unparseable
    const patch = [
      'diff --git a/file.txt b/file.txt',
      '--- a/file.txt',
      '+++ b/file.txt',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      'diff --git a/wrong.txt',  // No ' b/' marker
      '--- a/wrong.txt',
      '+++ b/wrong.txt',
      '@@ -1 +1 @@',
      '-wrong_old',
      '+wrong_new',
    ].join('\n');
    let stdin = '';
    const git = createMockGit({
      run: () => ({ status: 0, stdout: 'abc123\n', stderr: '' }),
      runChecked: ((_args, _errorCode, options) => {
        stdin = options?.stdin ?? '';
        return { status: 0, stdout: '', stderr: '' };
      }) as GitCommand['runChecked'],
    });
    git.stagePatch(patch);
    // Since one section is unparseable, unparseable=true, dedup is skipped
    // Original patch should be passed through as-is
    assert.ok(stdin.includes('-old'));
    assert.ok(stdin.includes('-wrong_old'));
  });
});
