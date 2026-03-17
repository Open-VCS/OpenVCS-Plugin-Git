// Copyright © 2025-2026 OpenVCS Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { spawnSync } from 'node:child_process';

import {
  createPluginRuntime,
  pluginError,
} from '@openvcs/sdk/runtime';

import { asString } from './plugin-helpers.js';
import { createGitVcsDelegates } from './plugin-request-handler.js';
import type { GitCommandResult, GitSession, RunGitOptions } from './plugin-types.js';

/** Stores the next session id allocated for `vcs.open`. Allocated once per plugin runtime instance
 * and persists for the lifetime of the process. Session IDs are opaque integers assigned
 * sequentially starting from 1. */
let nextSessionId = 1;

/** Stores all active repository sessions keyed by session id. */
const sessions = new Map<string, GitSession>();

/** Allocates a new repository session and returns its generated id. */
function allocateSession(session: GitSession): string {
  const sessionId = String(nextSessionId);
  nextSessionId += 1;
  sessions.set(sessionId, session);
  return sessionId;
}

/** Removes an existing repository session. */
function closeSession(sessionId: unknown): void {
  const key = asString(sessionId);
  if (!sessions.has(key)) {
    throw pluginError('vcs-invalid-session', `session '${key}' not found`);
  }
  sessions.delete(key);
}

/** Resolves a required session or throws a host-facing plugin error. */
function requireSession(sessionId: unknown): GitSession {
  const session = sessions.get(asString(sessionId));

  if (!session) {
    throw pluginError(
      'vcs-invalid-session',
      `unknown session '${asString(sessionId)}'`,
    );
  }

  return session;
}

/** Executes a git command and returns its captured outputs. */
function runGit(
  args: string[],
  cwd: string,
  options: RunGitOptions = {},
): GitCommandResult {
  const result = spawnSync('git', args, {
    cwd,
    input: typeof options.stdin === 'string' ? options.stdin : undefined,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });

  return {
    status: typeof result.status === 'number' ? result.status : -1,
    stdout: asString(result.stdout),
    stderr: asString(result.stderr),
  };
}

/** Executes a git command and raises a host-facing plugin error on failure. */
function runGitChecked(
  args: string[],
  cwd: string,
  errorCode: string,
  options: RunGitOptions = {},
): GitCommandResult {
  const output = runGit(args, cwd, options);

  if (output.status !== 0) {
    const message =
      output.stderr.trim() ||
      output.stdout.trim() ||
      `git exited with code ${output.status}`;
    throw pluginError(errorCode, message);
  }

  return output;
}

/** Creates the composed Git plugin runtime backed by the SDK transport layer. */
export function createGitPluginRuntime() {
  return createPluginRuntime({
    logTarget: 'openvcs.git.plugin',
    vcs: createGitVcsDelegates({
      allocateSession,
      closeSession,
      requireSession,
      runGit,
      runGitChecked,
    }),
  });
}
