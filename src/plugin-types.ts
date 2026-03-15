// Copyright © 2025-2026 OpenVCS Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

/** Represents a JSON-RPC request identifier. */
export type JsonRpcId = number | string;

/** Represents the raw parameter object for a JSON-RPC request. */
export type RequestParams = Record<string, unknown>;

/** Describes one JSON-RPC request received from the host. */
export interface JsonRpcRequest {
  /** Carries the request identifier used for matching responses. */
  id?: JsonRpcId;
  /** Carries the method name requested by the host. */
  method?: unknown;
  /** Carries the untyped parameter payload for the request. */
  params?: unknown;
}

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

/** Describes the host-facing error metadata embedded in plugin failures. */
export interface PluginFailureData {
  /** Stores the stable plugin-specific error code. */
  code: string;
  /** Stores the user-facing failure message. */
  message: string;
}

/** Describes one plugin failure payload thrown for host consumption. */
export interface PluginFailure {
  /** Stores the reserved JSON-RPC error code for plugin failures. */
  code: -32001;
  /** Stores the top-level failure message. */
  message: string;
  /** Stores nested plugin-specific failure details. */
  data: PluginFailureData;
}

/** Describes the aggregate repository status counts returned to the host. */
export interface StatusSummary {
  /** Counts untracked files. */
  untracked: number;
  /** Counts modified working tree files. */
  modified: number;
  /** Counts staged files. */
  staged: number;
  /** Counts conflicted files. */
  conflicted: number;
}

/** Describes one file entry in the OpenVCS status payload. */
export interface StatusFileEntry {
  /** Stores the current file path. */
  path: string;
  /** Stores the prior path for rename and copy records. */
  old_path: string | null;
  /** Stores the porcelain status code. */
  status: string;
  /** Indicates whether the file has staged changes. */
  staged: boolean;
  /** Indicates whether a conflict has been resolved. */
  resolved_conflict: boolean;
  /** Stores placeholder hunk information until richer diff support exists. */
  hunks: never[];
}

/** Describes the structured status payload returned to the host. */
export interface StatusPayload {
  /** Stores file-level status entries. */
  files: StatusFileEntry[];
  /** Stores the local branch ahead count relative to its upstream. */
  ahead: number;
  /** Stores the local branch behind count relative to its upstream. */
  behind: number;
}

/** Describes the complete parsed status result. */
export interface StatusParseResult {
  /** Stores the aggregate status summary. */
  summary: StatusSummary;
  /** Stores the detailed status payload. */
  payload: StatusPayload;
}

/** Describes one commit entry returned from `git log`. */
export interface CommitEntry {
  /** Stores the full commit id. */
  id: string;
  /** Stores the commit subject. */
  msg: string;
  /** Stores the author display name. */
  author: string;
  /** Stores the formatted metadata string. */
  meta: string;
}

/** Describes one stash entry returned to the host. */
export interface StashEntry {
  /** Stores the stash selector such as `stash@{0}`. */
  selector: string;
  /** Stores the stash message. */
  msg: string;
  /** Stores extra metadata reserved for future expansion. */
  meta: string;
}

/** Describes the optional stdin payload for one git subprocess. */
export interface RunGitOptions {
  /** Supplies content written to stdin before the child exits. */
  stdin?: string;
}
