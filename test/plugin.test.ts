// Copyright © 2025-2026 OpenVCS Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildFetchArgs,
  buildPullFfOnlyArgs,
  buildPushArgs,
  parseStatusOutput,
} from '../src/plugin-helpers.ts';

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
  });
});
