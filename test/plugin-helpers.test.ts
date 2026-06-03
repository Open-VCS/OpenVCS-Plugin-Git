// Copyright © 2025-2026 OpenVCS Contributors
// SPDX-License-Identifier: GPL-3.0-or-later
/// <reference types="node" />

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  applySubmoduleStatusHints,
  asNumber,
  asRecord,
  asString,
  asStringArray,
  asTrimmedString,
  buildCloneArgs,
  buildFetchArgs,
  buildPullArgs,
  buildPushArgs,
  buildSubmoduleUpdateArgs,
  parseStatusOutput,
} from '../src/plugin-helpers.js';

import { planDiscardPaths } from '../src/plugin-request-handler.js';

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

    it('keeps branch_on_remote false when ahead counts exist without an upstream marker', () => {
      const status = parseStatusOutput('## main [ahead 1]\0');

      assert.equal(status.payload.branch_on_remote, false);
      assert.equal(status.payload.ahead, 1);
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

    it('builds pull merge with no optional arguments', () => {
      assert.deepStrictEqual(buildPullArgs({}), ['pull', '--no-rebase', '--no-edit']);
    });

    it('builds pull merge with remote and branch', () => {
      assert.deepStrictEqual(buildPullArgs({ remote: 'origin', branch: 'main' }), [
        'pull',
        '--no-rebase',
        '--no-edit',
        'origin',
        'main',
      ]);
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

    it('skips file entries with whitespace-only path', () => {
      const plan = planDiscardPaths(' M tracked.txt\0??   \0');
      assert.deepStrictEqual(plan, {
        restore: ['tracked.txt'],
        unstageThenRemove: [],
        clean: [],
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

  describe('parseStatusOutput short records', () => {
    it('skips records shorter than 4 characters', () => {
      const status = parseStatusOutput('## main\0XY\0?? untracked.txt\0');
      assert.strictEqual(status.payload.files.length, 1);
      assert.strictEqual(status.payload.files[0].path, 'untracked.txt');
    });
  });

  describe('parseStatusOutput behind count', () => {
    it('parses behind count from status header', () => {
      const status = parseStatusOutput('## main...origin/main [behind 3]\0');
      assert.equal(status.payload.behind, 3);
      assert.equal(status.payload.ahead, 0);
    });

    it('parses both ahead and behind counts', () => {
      const status = parseStatusOutput('## main...origin/main [ahead 2, behind 5]\0');
      assert.equal(status.payload.ahead, 2);
      assert.equal(status.payload.behind, 5);
    });
  });

  describe('parseStatusOutput DD conflict', () => {
    it('normalizes DD porcelain state to conflict status U', () => {
      const status = parseStatusOutput('## main\0DD both-deleted.txt\0');
      assert.equal(status.summary.conflicted, 1);
      assert.equal(status.payload.files[0].status, 'U');
    });
  });

  describe('parseStatusOutput AA conflict', () => {
    it('normalizes AA porcelain state to conflict status U', () => {
      const status = parseStatusOutput('## main\0AA both-added.txt\0');
      assert.equal(status.summary.conflicted, 1);
      assert.equal(status.payload.files[0].status, 'U');
    });
  });

  describe('parseStatusOutput untracked summary', () => {
    it('counts untracked files in summary', () => {
      const status = parseStatusOutput('## main\0?? new1.txt\0?? new2.txt\0');
      assert.equal(status.summary.untracked, 2);
    });
  });

  describe('parseStatusOutput staged and modified summary', () => {
    it('counts staged and modified files separately', () => {
      const status = parseStatusOutput('## main\0M  staged.txt\0 M modified.txt\0');
      assert.equal(status.summary.staged, 1);
      assert.equal(status.summary.modified, 1);
    });
  });

  describe('parseStatusOutput status fallback to M', () => {
    it('falls back to M when status is both spaces', () => {
      const status = parseStatusOutput('## main\0   untracked.txt\0');
      assert.equal(status.payload.files[0].status, 'M');
    });
  });

  describe('applySubmoduleStatusHints edge cases', () => {
    it('returns parsed unchanged when no submodule paths given', () => {
      const parsed = parseStatusOutput('## main\0 M file.txt\0');
      const result = applySubmoduleStatusHints(parsed, []);
      assert.strictEqual(result, parsed);
    });

    it('leaves non-submodule files unchanged', () => {
      const parsed = parseStatusOutput('## main\0 M file.txt\0 M deps/lib\0');
      const result = applySubmoduleStatusHints(parsed, ['deps/lib']);
      const files = result.payload.files;
      assert.strictEqual(files[0].status, 'M');
      assert.strictEqual(files[1].status, 'S');
    });
  });
});

describe('Coercion helpers', () => {
  describe('asRecord', () => {
    it('returns empty object for null input', () => {
      assert.deepStrictEqual(asRecord(null), {});
    });

    it('returns empty object for undefined input', () => {
      assert.deepStrictEqual(asRecord(undefined), {});
    });

    it('returns empty object for non-object input', () => {
      assert.deepStrictEqual(asRecord('string'), {});
      assert.deepStrictEqual(asRecord(42), {});
    });

    it('returns empty object for array input', () => {
      assert.deepStrictEqual(asRecord([1, 2, 3]), {});
    });

    it('passes through plain objects', () => {
      const obj = { key: 'value' };
      assert.strictEqual(asRecord(obj), obj);
    });
  });

  describe('asString', () => {
    it('preserves string values', () => {
      assert.strictEqual(asString('hello'), 'hello');
    });

    it('coerces numbers to string', () => {
      assert.strictEqual(asString(42), '42');
    });

    it('coerces null to empty string', () => {
      assert.strictEqual(asString(null), '');
    });

    it('coerces undefined to empty string', () => {
      assert.strictEqual(asString(undefined), '');
    });

    it('coerces objects to their string representation', () => {
      assert.strictEqual(asString({}), '[object Object]');
    });
  });

  describe('asTrimmedString', () => {
    it('trims whitespace from strings', () => {
      assert.strictEqual(asTrimmedString('  hello  '), 'hello');
    });

    it('returns empty string for null', () => {
      assert.strictEqual(asTrimmedString(null), '');
    });
  });

  describe('asNumber', () => {
    it('preserves finite numbers', () => {
      assert.strictEqual(asNumber(42, 0), 42);
    });

    it('parses numeric strings', () => {
      assert.strictEqual(asNumber('42', 0), 42);
    });

    it('returns fallback for NaN', () => {
      assert.strictEqual(asNumber(NaN, 10), 10);
    });

    it('treats null as 0 (Number(null) is 0)', () => {
      assert.strictEqual(asNumber(null, 10), 0);
    });

    it('returns fallback for undefined', () => {
      assert.strictEqual(asNumber(undefined, 10), 10);
    });

    it('returns fallback for non-numeric strings', () => {
      assert.strictEqual(asNumber('not-a-number', 10), 10);
    });
  });

  describe('asStringArray', () => {
    it('passes through string arrays', () => {
      assert.deepStrictEqual(asStringArray(['a', 'b']), ['a', 'b']);
    });

    it('filters out falsy entries', () => {
      assert.deepStrictEqual(asStringArray(['a', '', null, 'b', undefined]), ['a', 'b']);
    });

    it('returns empty array for non-array input', () => {
      assert.deepStrictEqual(asStringArray('not-array'), []);
      assert.deepStrictEqual(asStringArray(null), []);
    });

    it('coerces non-string elements to string', () => {
      assert.deepStrictEqual(asStringArray([1, true]), ['1', 'true']);
    });
  });
});
