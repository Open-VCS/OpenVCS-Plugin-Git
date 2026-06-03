// Copyright © 2025-2026 OpenVCS Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

export type {
  CommitEntry,
  JsonRpcId,
  RequestParams,
  StashEntry,
  StatusFileEntry,
  StatusParseResult,
  StatusPayload,
  StatusSummary,
  VcsDiffFileResponse,
  VcsDiffResult,
} from '@openvcs/sdk/types';

/** Describes one opened Git repository session. */
export interface GitSession {
  /** Stores the absolute repository path for the session. */
  path: string;
}

/** Describes the captured result of one git subprocess. */
export interface GitCommandResult {
  /** Stores the subprocess exit status. */
  status: number;
  /** Stores captured standard output. */
  stdout: string;
  /** Stores captured standard error. */
  stderr: string;
}

/** Describes the optional stdin payload for one git subprocess. */
export interface RunGitOptions {
  /** Supplies content written to stdin before the child exits. */
  stdin?: string;
}
