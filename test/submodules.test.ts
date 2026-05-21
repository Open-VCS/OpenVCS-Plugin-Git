// Copyright © 2025-2026 OpenVCS Contributors
// SPDX-License-Identifier: GPL-3.0-or-later
/// <reference types="node" />

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  asPayload,
  buildSubmoduleRow,
  handleSubmoduleModalError,
  payloadString,
  registerSubmoduleToolkit,
} from '../src/submodules.js';
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

  it('builds a row without optional fields', () => {
    const entry: SubmoduleEntry = {
      path: 'libs/minimal',
      name: 'minimal',
      state: 'dirty',
    };

    const row = buildSubmoduleRow(entry);

    assert.strictEqual(row.id, 'libs/minimal');
    assert.strictEqual(row.status, 'dirty');
    assert.strictEqual(row.meta, 'minimal');
    assert.strictEqual(row.description, '');
  });

  it('builds a row with danger variant on remove action', () => {
    const entry: SubmoduleEntry = {
      path: 'libs/example',
      name: 'example',
      state: 'uninitialized',
    };

    const row = buildSubmoduleRow(entry);

    const removeAction = row.actions.find((a) => a.id === 'submodules-remove-request');
    assert.ok(removeAction);
    assert.strictEqual(removeAction.variant, 'danger');
    assert.deepStrictEqual(removeAction.payload, { path: 'libs/example', name: 'example' });
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

    it('handles non-Error error objects', async () => {
      const messages: string[] = [];

      const result = await handleSubmoduleModalError(
        'something broke',
        'string error',
        async (message) => {
          messages.push(message);
          return 'handled';
        },
      );

      assert.strictEqual(result, 'handled');
      assert.deepStrictEqual(messages, ['something broke: string error']);
    });
  });

  describe('registerSubmoduleToolkit', () => {
    it('registers without throwing', () => {
      registerSubmoduleToolkit();
      assert.ok('registerSubmoduleToolkit completed without error');
    });
  });

  describe('asPayload', () => {
    it('returns empty object for null', () => {
      assert.deepStrictEqual(asPayload(null), {});
    });

    it('returns empty object for undefined', () => {
      assert.deepStrictEqual(asPayload(undefined), {});
    });

    it('returns empty object for string', () => {
      assert.deepStrictEqual(asPayload('string'), {});
    });

    it('returns empty object for array', () => {
      assert.deepStrictEqual(asPayload([1, 2]), {});
    });

    it('passes through plain objects', () => {
      const obj = { key: 'value' };
      assert.strictEqual(asPayload(obj), obj);
    });
  });

  describe('payloadString', () => {
    it('returns trimmed string value for existing key', () => {
      assert.strictEqual(payloadString({ path: '  libs/repo  ' }, 'path'), 'libs/repo');
    });

    it('returns empty string for missing key', () => {
      assert.strictEqual(payloadString({}, 'missing'), '');
    });

    it('returns empty string for null value', () => {
      assert.strictEqual(payloadString({ key: null }, 'key'), '');
    });

    it('coerces numeric values to string', () => {
      assert.strictEqual(payloadString({ count: 42 }, 'count'), '42');
    });
  });
});
