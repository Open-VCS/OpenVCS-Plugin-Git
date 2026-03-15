// Copyright © 2025-2026 OpenVCS Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { spawnSync } from 'node:child_process';

import { asString, pluginError } from './plugin-helpers.js';
import { handleMessage } from './plugin-request-handler.js';
import type {
  GitCommandResult,
  GitSession,
  JsonRpcId,
  JsonRpcRequest,
  RunGitOptions,
} from './plugin-types.js';

/** Stores the protocol version reported during plugin initialization. */
const PROTOCOL_VERSION = 1;

/** Stores the next session id allocated for `vcs.open`. */
let nextSessionId = 1;

/** Stores all active repository sessions keyed by session id. */
const sessions = new Map<string, GitSession>();

/** Stores unread bytes from the host transport. */
let buffer = Buffer.alloc(0);

/** Stores the current sequential request-processing chain. */
let processing: Promise<void> = Promise.resolve();

/** Tracks whether stdin listeners have already been registered. */
let runtimeStarted = false;

/** Writes one framed JSON-RPC payload to stdout. */
function send(value: unknown): void {
  const payload = Buffer.from(JSON.stringify(value), 'utf8');
  const header = Buffer.from(
    `Content-Length: ${payload.length}\r\n\r\n`,
    'utf8',
  );
  process.stdout.write(header);
  process.stdout.write(payload);
}

/** Emits a JSON-RPC success response. */
function sendResult(id: JsonRpcId, result: unknown): void {
  send({ jsonrpc: '2.0', id, result });
}

/** Emits a JSON-RPC error response. */
function sendError(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
): void {
  send({
    jsonrpc: '2.0',
    id,
    error: {
      code,
      message,
      ...(data == null ? {} : { data }),
    },
  });
}

/** Emits a host log notification for diagnostics. */
function emitHostLog(level: 'error' | 'info', message: string): void {
  send({
    jsonrpc: '2.0',
    method: 'host.log',
    params: {
      level,
      target: 'openvcs.git.plugin',
      message,
    },
  });
}

/** Emits a progress notification for long-running VCS operations. */
function emitVcsEvent(
  sessionId: string,
  requestId: JsonRpcId | null,
  event: Record<string, unknown>,
): void {
  send({
    jsonrpc: '2.0',
    method: 'vcs.event',
    params: {
      session_id: sessionId,
      request_id: requestId,
      event,
    },
  });
}

/** Allocates a new repository session and returns its generated id. */
function allocateSession(session: GitSession): string {
  const sessionId = String(nextSessionId);
  nextSessionId += 1;
  sessions.set(sessionId, session);
  return sessionId;
}

/** Removes an existing repository session. */
function closeSession(sessionId: unknown): void {
  sessions.delete(asString(sessionId));
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
    status: typeof result.status === 'number' ? result.status : 1,
    stdout: asString(result.stdout),
    stderr: asString(result.stderr),
  };
}

/** Executes a git command and raises a host-facing plugin error on failure. */
function runGitChecked(
  args: string[],
  cwd: string,
  errorCode: string,
  requestId: JsonRpcId | null = null,
  sessionId: string | null = null,
  eventPhase: string | null = null,
  options: RunGitOptions = {},
): GitCommandResult {
  if (eventPhase && sessionId) {
    emitVcsEvent(sessionId, requestId, {
      type: 'progress',
      phase: eventPhase,
      detail: `running: git ${args.join(' ')}`,
    });
  }

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

/** Parses buffered host frames and schedules request handling sequentially. */
function consumeFrames(): void {
  while (true) {
    const marker = buffer.indexOf('\r\n\r\n');
    if (marker < 0) {
      return;
    }

    const header = buffer.subarray(0, marker).toString('utf8');
    const headerLines = header.split(/\r?\n/g);
    let contentLength = 0;

    for (const line of headerLines) {
      const separatorIndex = line.indexOf(':');
      if (separatorIndex < 0) {
        continue;
      }

      const name = line.slice(0, separatorIndex).trim().toLowerCase();
      if (name !== 'content-length') {
        continue;
      }

      contentLength = Number(line.slice(separatorIndex + 1).trim()) || 0;
    }

    const totalLength = marker + 4 + contentLength;
    if (buffer.length < totalLength) {
      return;
    }

    const payload = buffer.subarray(marker + 4, totalLength).toString('utf8');
    buffer = buffer.subarray(totalLength);

    let message: JsonRpcRequest;
    try {
      message = JSON.parse(payload) as JsonRpcRequest;
    } catch {
      continue;
    }

    processing = processing
      .then(async () => {
        await handleMessage(message, {
          protocolVersion: PROTOCOL_VERSION,
          sendResult,
          sendError,
          emitHostLog,
          allocateSession,
          closeSession,
          requireSession,
          runGit,
          runGitChecked,
        });
      })
      .catch((error: unknown) => {
        const messageText =
          error instanceof Error
            ? error.message
            : asString(error || 'unknown plugin processing error');
        emitHostLog('error', messageText);
      });
  }
}

/** Registers transport listeners and starts the plugin runtime loop. */
export function startPluginRuntime(): void {
  if (runtimeStarted) {
    return;
  }

  runtimeStarted = true;

  process.stdin.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    consumeFrames();
  });

  process.stdin.on('error', () => {
    process.exit(1);
  });
}
