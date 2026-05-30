// Copyright © 2025-2026 OpenVCS Contributors
// SPDX-License-Identifier: GPL-3.0-or-later
/// <reference types="node" />

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import {
  allocateSession,
  closeSession,
  requireSession,
  resetSessions,
} from '../src/plugin-runtime.js';

describe('plugin runtime session management', () => {
  beforeEach(() => {
    resetSessions();
  });

  it('allocates sequential session ids starting from 1', () => {
    const id1 = allocateSession({ path: '/repo1' });
    const id2 = allocateSession({ path: '/repo2' });
    const id3 = allocateSession({ path: '/repo3' });

    assert.strictEqual(id1, '1');
    assert.strictEqual(id2, '2');
    assert.strictEqual(id3, '3');
  });

  it('requires an existing session and returns it', () => {
    allocateSession({ path: '/my-repo' });
    const session = requireSession('1');
    assert.deepStrictEqual(session, { path: '/my-repo' });
  });

  it('throws vcs-invalid-session when requiring a missing session', () => {
    assert.throws(
      () => requireSession('nonexistent'),
      (err: Error) => {
        assert.match(err.message, /unknown session/);
        return true;
      },
    );
  });

  it('closes an existing session', () => {
    allocateSession({ path: '/repo' });
    closeSession('1');
    assert.throws(
      () => requireSession('1'),
      (err: Error) => {
        assert.match(err.message, /unknown session/);
        return true;
      },
    );
  });

  it('throws when closing a missing session', () => {
    assert.throws(
      () => closeSession('missing'),
      (err: Error) => {
        assert.match(err.message, /session.*not found/);
        return true;
      },
    );
  });

  it('handles closeSession with non-string session id', () => {
    allocateSession({ path: '/repo' });
    closeSession(1);
    assert.throws(
      () => requireSession('1'),
      (err: Error) => {
        assert.match(err.message, /unknown session/);
        return true;
      },
    );
  });

  it('resets sessions completely', () => {
    allocateSession({ path: '/repo' });
    resetSessions();
    assert.throws(
      () => requireSession('1'),
      (err: Error) => {
        assert.match(err.message, /unknown session/);
        return true;
      },
    );

    // After reset, new sessions start at 1 again
    const id = allocateSession({ path: '/new-repo' });
    assert.strictEqual(id, '1');
  });
});
