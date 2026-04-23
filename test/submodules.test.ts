// Copyright © 2025-2026 OpenVCS Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildSubmoduleRow, handleSubmoduleModalError } from '../src/submodules.js';
import type { SubmoduleEntry } from '../src/git.js';

describe('submodules', () => {
  it('builds a row with the expected actions', () => {
    const entry: SubmoduleEntry = {
      path: 'libs/example',
      name: 'example',
      url: 'https://example.com/repo.git',
      branch: 'main',
      commit: 'abc123',
      state: 'clean',
    };

    const row = buildSubmoduleRow(entry);

    assert.strictEqual(row.id, 'libs/example');
    assert.deepStrictEqual(
      row.actions.map((action) => action.id),
      ['submodules-update', 'submodules-update-remote', 'submodules-sync', 'submodules-remove-request'],
    );
  });

  describe('handleSubmoduleModalError', () => {
    it('opens a fallback modal with the formatted message', async () => {
      const messages: string[] = [];

      const result = await handleSubmoduleModalError(
        'failed to list submodules',
        new Error('boom'),
        async (message) => {
          messages.push(message);
          return 'fallback-opened';
        },
      );

      assert.strictEqual(result, 'fallback-opened');
      assert.deepStrictEqual(messages, ['failed to list submodules: boom']);
    });

    it('rethrows the original error when the fallback modal also fails', async () => {
      const originalError = new Error('primary failure');

      await assert.rejects(
        () => handleSubmoduleModalError('failed to open modal', originalError, async () => {
          throw new Error('fallback failure');
        }),
        (error) => error === originalError,
      );
    });
  });
});
