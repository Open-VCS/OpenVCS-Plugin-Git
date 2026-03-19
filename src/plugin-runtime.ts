// Copyright © 2025-2026 OpenVCS Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { pluginError } from '@openvcs/sdk/runtime';

import { asString } from './plugin-helpers.js';
import type { GitSession } from './plugin-types.js';

/** Stores the next session id allocated for `vcs.open`. Allocated once per plugin runtime instance
 * and persists for the lifetime of the process. Session IDs are opaque integers assigned
 * sequentially starting from 1. */
let nextSessionId = 1;

/** Stores all active repository sessions keyed by session id. */
const sessions = new Map<string, GitSession>();

/** Allocates a new repository session and returns its generated id. */
export function allocateSession(session: GitSession): string {
  const sessionId = String(nextSessionId);
  nextSessionId += 1;
  sessions.set(sessionId, session);
  return sessionId;
}

/** Removes an existing repository session. */
export function closeSession(sessionId: unknown): void {
  const key = asString(sessionId);
  if (!sessions.has(key)) {
    throw pluginError('vcs-invalid-session', `session '${key}' not found`);
  }
  sessions.delete(key);
}

/** Resets all session state. Useful for testing to ensure clean state between test runs. */
export function resetSessions(): void {
  nextSessionId = 1;
  sessions.clear();
}

/** Resolves a required session or throws a host-facing plugin error. */
export function requireSession(sessionId: unknown): GitSession {
  const session = sessions.get(asString(sessionId));

  if (!session) {
    throw pluginError(
      'vcs-invalid-session',
      `unknown session '${asString(sessionId)}'`,
    );
  }

  return session;
}
