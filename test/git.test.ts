// Copyright © 2025-2026 OpenVCS Contributors
// SPDX-License-Identifier: GPL-3.0-or-later
/// <reference types="node" />

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GitCommand, type FetchOptions, type PullOptions } from '../src/git.js';

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

describe('GitCommand', () => {
  describe('version', () => {
    it('parses git version output', () => {
      const git = createMockGit({
        run: () => ({ status: 0, stdout: 'git version 2.40.0\n', stderr: '' }),
      });
      const v = git.version();
      assert.strictEqual(v.major, 2);
      assert.strictEqual(v.minor, 40);
      assert.match(v.version, /^git version 2\.40/);
    });

    it('throws on unparseable version output', () => {
      const git = createMockGit({
        run: () => ({ status: 0, stdout: 'unknown tool v1.0\n', stderr: '' }),
      });
      assert.throws(() => git.version(), /Unable to parse Git version/);
    });
  });

  describe('run signal handling', () => {
    it('returns graceful error when process is killed by signal', () => {
      const git = createMockGit();
      git.run = () => ({ status: -2, stdout: '', stderr: 'Killed' });
      const result = git.run(['status']);
      assert.strictEqual(result.status, -2);
      assert.match(result.stderr, /Killed/);
    });
  });

  describe('status', () => {
    it('applies submodule status hints from .gitmodules', () => {
      const git = createMockGit({
        run: (args: string[]) => {
          if (args[0] === 'status') {
            return { status: 0, stdout: '## main\0 M libs/repo\0 M file.txt\0', stderr: '' };
          }
          if (args.includes('-f') && args.includes('.gitmodules')) {
            return {
              status: 0,
              stdout: 'submodule.libs/repo.path\nlibs/repo\0',
              stderr: '',
            };
          }
          return { status: 0, stdout: '', stderr: '' };
        },
      });

      const status = git.status();

      assert.strictEqual(status.exitCode, 0);
      assert.strictEqual(status.payload.files[0].status, 'S');
      assert.strictEqual(status.payload.files[1].status, 'M');
    });

    it('marks untracked worktree binaries in status payloads', () => {
      const repoPath = mkdtempSync(join(tmpdir(), 'openvcs-git-binary-status-'));
      try {
        writeFileSync(join(repoPath, 'img.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]));
        const git = new GitCommand(repoPath);
        git.run = ((args: string[]) => {
          if (args[0] === 'status') {
            return { status: 0, stdout: '## main\0?? img.png\0', stderr: '' };
          }
          return { status: 1, stdout: '', stderr: '' };
        }) as GitCommand['run'];

        const status = git.status();

        assert.strictEqual(status.payload.files[0].path, 'img.png');
        assert.strictEqual(status.payload.files[0].binary, true);
      } finally {
        rmSync(repoPath, { recursive: true, force: true });
      }
    });
  });

  describe('diffFile', () => {
    it('returns structured binary metadata for worktree binaries with no textual diff', () => {
      const repoPath = mkdtempSync(join(tmpdir(), 'openvcs-git-binary-diff-'));
      try {
        writeFileSync(join(repoPath, 'img.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]));
        const git = new GitCommand(repoPath);
        git.runChecked = (() => ({ status: 0, stdout: '', stderr: '' })) as GitCommand['runChecked'];

        assert.deepStrictEqual(git.diffFile('img.png'), {
          lines: [],
          binary: true,
        });
      } finally {
        rmSync(repoPath, { recursive: true, force: true });
      }
    });
  });

  describe('runChecked error handling', () => {
    it('throws pluginError on non-zero exit', () => {
      const git = createMockGit({
        run: () => ({ status: 1, stdout: '', stderr: 'fatal: not a git repository' }),
      });
      assert.throws(
        () => git.runChecked(['status'], 'git-status-failed'),
        (err: Error) => {
          assert.match(err.message, /not a git repository/);
          return true;
        },
      );
    });

    it('falls back to stdout when stderr is empty', () => {
      const git = createMockGit({
        run: () => ({ status: 1, stdout: 'something on stdout\n', stderr: '' }),
      });
      assert.throws(
        () => git.runChecked(['status'], 'git-status-failed'),
        (err: Error) => {
          assert.match(err.message, /something on stdout/);
          return true;
        },
      );
    });

    it('falls back to command and exit code when stderr and stdout are empty', () => {
      const git = createMockGit({
        run: () => ({ status: 2, stdout: '', stderr: '' }),
      });

      assert.throws(
        () => git.runChecked(['status'], 'git-status-failed'),
        (err: Error) => {
          assert.match(err.message, /git status \(exit code: 2\)/);
          return true;
        },
      );
    });
  });

  describe('currentHead', () => {
    it('returns the trimmed HEAD commit hash', () => {
      const git = createMockGit({
        runChecked: () => ({ status: 0, stdout: 'abc123\n', stderr: '' }),
      });
      assert.strictEqual(git.currentHead(), 'abc123');
    });
  });

  describe('currentBranch', () => {
    it('returns the checked out branch name', () => {
      const git = createMockGit({
        runChecked: () => ({ status: 0, stdout: 'main\n', stderr: '' }),
      });
      assert.strictEqual(git.currentBranch(), 'main');
    });
  });

  describe('listBranches', () => {
    it('parses branch output and marks current branch', () => {
      const git = createMockGit({
        run: () => ({
          status: 0,
          stdout: 'main*\nfeature\nremotes/origin/main\n',
          stderr: '',
        }),
        runChecked: () => ({ status: 0, stdout: 'main\n', stderr: '' }),
      });
      const result = git.listBranches();
      assert.strictEqual(result.current, 'main');
      assert.strictEqual(result.branches.length, 3);
      assert.strictEqual(result.branches[0].current, true);
    });
  });

  describe('listLocalBranches', () => {
    it('parses local branch output', () => {
      const git = createMockGit({
        run: () => ({
          status: 0,
          stdout: 'main\nfeature\n',
          stderr: '',
        }),
        runChecked: () => ({ status: 0, stdout: 'main\n', stderr: '' }),
      });
      const result = git.listLocalBranches();
      assert.strictEqual(result.branches.length, 2);
      assert.strictEqual(result.branches[0].current, true);
    });
  });

  describe('branch CRUD', () => {
    it('createBranch passes branch name to runChecked', () => {
      const { git, args } = captureRun();
      git.runChecked = ((a: string[]) => {
        args.push(a);
        return { status: 0, stdout: '', stderr: '' };
      }) as GitCommand['runChecked'];
      git.createBranch('feature/test');
      assert.deepStrictEqual(args[0], ['branch', 'feature/test']);
    });

    it('checkoutBranch passes branch name to runChecked', () => {
      const { git, args } = captureRun();
      git.runChecked = ((a: string[]) => {
        args.push(a);
        return { status: 0, stdout: '', stderr: '' };
      }) as GitCommand['runChecked'];
      git.checkoutBranch('main');
      assert.deepStrictEqual(args[0], ['checkout', 'main']);
    });

    it('deleteBranch passes branch name to runChecked', () => {
      const { git, args } = captureRun();
      git.runChecked = ((a: string[]) => {
        args.push(a);
        return { status: 0, stdout: '', stderr: '' };
      }) as GitCommand['runChecked'];
      git.deleteBranch('old-feature');
      assert.deepStrictEqual(args[0], ['branch', '-d', 'old-feature']);
    });

    it('renameBranch passes old and new names to runChecked', () => {
      const { git, args } = captureRun();
      git.runChecked = ((a: string[]) => {
        args.push(a);
        return { status: 0, stdout: '', stderr: '' };
      }) as GitCommand['runChecked'];
      git.renameBranch('old-name', 'new-name');
      assert.deepStrictEqual(args[0], ['branch', '-m', 'old-name', 'new-name']);
    });
  });

  describe('branch upstream', () => {
    it('getBranchUpstream returns upstream when status is 0', () => {
      const git = createMockGit({
        run: () => ({ status: 0, stdout: 'origin/main\n', stderr: '' }),
      });
      assert.strictEqual(git.getBranchUpstream('main'), 'origin/main');
    });

    it('getBranchUpstream returns null on failure', () => {
      const git = createMockGit({
        run: () => ({ status: 128, stdout: '', stderr: '' }),
      });
      assert.strictEqual(git.getBranchUpstream('main'), null);
    });

    it('setBranchUpstream passes correct args', () => {
      const { git, args } = captureRun();
      git.runChecked = ((a: string[]) => {
        args.push(a);
        return { status: 0, stdout: '', stderr: '' };
      }) as GitCommand['runChecked'];
      git.setBranchUpstream('main', 'origin/main');
      assert.deepStrictEqual(args[0], ['branch', '--set-upstream-to', 'origin/main', 'main']);
    });
  });

  describe('remote management', () => {
    it('ensureRemote adds a remote when it does not exist', () => {
      const calls: string[][] = [];
      const git = createMockGit({
        run: (a: string[]) => {
          calls.push(a);
          return { status: 128, stdout: '', stderr: '' };
        },
        runChecked: (a: string[]) => {
          calls.push(a);
          return { status: 0, stdout: '', stderr: '' };
        },
      });
      git.ensureRemote('origin', 'https://example.com/repo.git');
      assert.deepStrictEqual(calls[0], ['remote', 'get-url', 'origin']);
      assert.deepStrictEqual(calls[1], ['remote', 'add', 'origin', 'https://example.com/repo.git']);
    });

    it('ensureRemote updates URL when different', () => {
      const calls: string[][] = [];
      const git = createMockGit({
        run: (a: string[]) => {
          calls.push(a);
          return { status: 0, stdout: 'https://old-url.com\n', stderr: '' };
        },
        runChecked: (a: string[]) => {
          calls.push(a);
          return { status: 0, stdout: '', stderr: '' };
        },
      });
      git.ensureRemote('origin', 'https://new-url.com');
      assert.deepStrictEqual(calls[1], ['remote', 'set-url', 'origin', 'https://new-url.com']);
    });

    it('ensureRemote skips update when URL matches', () => {
      const calls: string[][] = [];
      const git = createMockGit({
        run: (a: string[]) => {
          calls.push(a);
          return { status: 0, stdout: 'https://example.com/repo.git\n', stderr: '' };
        },
      });
      git.ensureRemote('origin', 'https://example.com/repo.git');
      assert.strictEqual(calls.length, 1);
      assert.deepStrictEqual(calls[0], ['remote', 'get-url', 'origin']);
    });

    it('listRemotes parses fetch/push URLs', () => {
      const git = createMockGit({
        runChecked: () => ({
          status: 0,
          stdout: 'origin\thttps://example.com/repo.git (fetch)\norigin\thttps://example.com/repo.git (push)\n',
          stderr: '',
        }),
      });
      const result = git.listRemotes();
      assert.strictEqual(result.remotes.length, 1);
      assert.strictEqual(result.remotes[0].name, 'origin');
      assert.strictEqual(result.remotes[0].fetch, 'https://example.com/repo.git');
      assert.strictEqual(result.remotes[0].push, 'https://example.com/repo.git');
    });

    it('removeRemote passes correct args', () => {
      const { git, args } = captureRun();
      git.runChecked = ((a: string[]) => {
        args.push(a);
        return { status: 0, stdout: '', stderr: '' };
      }) as GitCommand['runChecked'];
      git.removeRemote('origin');
      assert.deepStrictEqual(args[0], ['remote', 'remove', 'origin']);
    });
  });

  describe('network commands', () => {
    it('fetch builds args from options', () => {
      const { git, args } = captureRun();
      git.runChecked = ((a: string[]) => {
        args.push(a);
        return { status: 0, stdout: '', stderr: '' };
      }) as GitCommand['runChecked'];
      const opts: FetchOptions = { remote: 'origin', refspec: 'main', opts: { prune: true } };
      git.fetch(opts);
      assert.deepStrictEqual(args[0], ['fetch', '--prune', 'origin', 'main']);
    });

    it('push builds args from options', () => {
      const { git, args } = captureRun();
      git.runChecked = ((a: string[]) => {
        args.push(a);
        return { status: 0, stdout: '', stderr: '' };
      }) as GitCommand['runChecked'];
      git.push({ remote: 'origin', refspec: 'main' });
      assert.deepStrictEqual(args[0], ['push', 'origin', 'main']);
    });

    it('pull builds args from options', () => {
      const { git, args } = captureRun();
      git.runChecked = ((a: string[]) => {
        args.push(a);
        return { status: 0, stdout: '', stderr: '' };
      }) as GitCommand['runChecked'];
      const opts: PullOptions = { remote: 'origin', branch: 'main' };
      git.pull(opts);
      assert.deepStrictEqual(args[0], ['pull', '--no-rebase', '--no-edit', 'origin', 'main']);
    });
  });

  describe('commit operations', () => {
    it('commit passes message, name, email, and paths', () => {
      const { git, args } = captureRun();
      git.runChecked = ((a: string[]) => {
        args.push(a);
        return { status: 0, stdout: '', stderr: '' };
      }) as GitCommand['runChecked'];
      git.commit('fix bug', 'Test User', 'test@example.com', ['src/index.ts']);
      assert.deepStrictEqual(args[0], [
        '-c', 'user.name=Test User',
        '-c', 'user.email=test@example.com',
        'commit', '-m', 'fix bug',
        '--', 'src/index.ts',
      ]);
    });

    it('commit omits name/email when not provided', () => {
      const { git, args } = captureRun();
      git.runChecked = ((a: string[]) => {
        args.push(a);
        return { status: 0, stdout: '', stderr: '' };
      }) as GitCommand['runChecked'];
      git.commit('simple commit');
      assert.deepStrictEqual(args[0], ['commit', '-m', 'simple commit']);
    });

    it('commitIndex uses default message when none provided', () => {
      const { git, args } = captureRun();
      git.runChecked = ((a: string[]) => {
        args.push(a);
        return { status: 0, stdout: '', stderr: '' };
      }) as GitCommand['runChecked'];
      git.commitIndex();
      assert.deepStrictEqual(args[0], ['commit', '-m', 'Stage changes']);
    });
  });

  describe('stagePaths', () => {
    it('skips git call when paths array is empty', () => {
      let called = false;
      const git = createMockGit({
        runChecked: () => {
          called = true;
          return { status: 0, stdout: '', stderr: '' };
        },
      });
      git.stagePaths([]);
      assert.strictEqual(called, false);
    });

    it('passes paths to add -A', () => {
      const { git, args } = captureRun();
      git.runChecked = ((a: string[]) => {
        args.push(a);
        return { status: 0, stdout: '', stderr: '' };
      }) as GitCommand['runChecked'];
      git.stagePaths(['file1.txt', 'file2.txt']);
      assert.deepStrictEqual(args[0], ['add', '-A', '--', 'file1.txt', 'file2.txt']);
    });
  });

  describe('diff operations', () => {
    it('diffFile combines cached and worktree diff', () => {
      const git = createMockGit({
        runChecked: (a: string[]) => {
          if (a.includes('--cached')) return { status: 0, stdout: 'cached diff\n', stderr: '' };
          return { status: 0, stdout: 'worktree diff\n', stderr: '' };
        },
      });
      const diff = git.diffFile('tracked.txt');
      assert.deepStrictEqual(diff, {
        lines: ['cached diff', 'worktree diff'],
        binary: false,
      });
    });

    it('diffCommit diffs against parent when parent exists', () => {
      const git = createMockGit({
        run: () => ({ status: 0, stdout: 'abc123^\n', stderr: '' }),
        runChecked: () => ({ status: 0, stdout: 'diff output\n', stderr: '' }),
      });
      const diff = git.diffCommit('abc123');
      assert.match(diff, /diff output/);
    });

    it('diffCommit uses diff-tree for root commit', () => {
      const calls: string[][] = [];
      const git = createMockGit({
        run: (a: string[]) => {
          calls.push(a);
          return { status: 128, stdout: '', stderr: '' };
        },
        runChecked: (a: string[]) => {
          calls.push(a);
          return { status: 0, stdout: 'root diff\n', stderr: '' };
        },
      });
      const diff = git.diffCommit('abc123');
      assert.deepStrictEqual(calls[1], ['diff-tree', '--root', '--no-commit-id', '--no-ext-diff', '-p', 'abc123']);
      assert.match(diff, /root diff/);
    });
  });

  describe('listCommits options', () => {
    it('adds branch and path filters when provided', () => {
      const { git, args } = captureRun();
      git.runChecked = ((a: string[]) => {
        args.push(a);
        return { status: 0, stdout: '', stderr: '' };
      }) as GitCommand['runChecked'];

      git.listCommits({ branch: 'feature', path: 'src/file.ts' });

      assert.ok(args[0].includes('feature'));
      assert.deepStrictEqual(args[0].slice(-3), ['feature', '--', 'src/file.ts']);
    });

    it('adds author and date filters when provided', () => {
      const { git, args } = captureRun();
      git.runChecked = ((a: string[]) => {
        args.push(a);
        return { status: 0, stdout: '', stderr: '' };
      }) as GitCommand['runChecked'];

      git.listCommits({
        author_contains: 'Ada',
        since_utc: '2026-01-01T00:00:00Z',
        until_utc: '2026-02-01T00:00:00Z',
      });

      assert.ok(args[0].includes('--author=Ada'));
      assert.ok(args[0].includes('--since=2026-01-01T00:00:00Z'));
      assert.ok(args[0].includes('--until=2026-02-01T00:00:00Z'));
    });

    it('adds topology, skip, and no-merge filters when provided', () => {
      const { git, args } = captureRun();
      git.runChecked = ((a: string[]) => {
        args.push(a);
        return { status: 0, stdout: '', stderr: '' };
      }) as GitCommand['runChecked'];

      git.listCommits({ topo_order: true, skip: 2, include_merges: false });

      assert.ok(args[0].includes('--topo-order'));
      assert.ok(args[0].includes('--skip=2'));
      assert.ok(args[0].includes('--no-merges'));
    });
  });
});
