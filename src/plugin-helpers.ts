// Copyright © 2025-2026 OpenVCS Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import type {
  CommitEntry,
  RequestParams,
  StatusFileEntry,
  StatusParseResult,
  StatusSummary,
} from './plugin-types.js';

/** Returns a plain object parameter map or an empty object for invalid input. */
export function asRecord(value: unknown): RequestParams {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return value as RequestParams;
}

/** Coerces any value into a string while preserving empty defaults. */
export function asString(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '');
}

/** Coerces any value into a trimmed string. */
export function asTrimmedString(value: unknown): string {
  return asString(value).trim();
}

/** Coerces any value into a finite number or returns a fallback. */
export function asNumber(value: unknown, fallback: number): number {
  const numericValue = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numericValue) ? numericValue : fallback;
}

/** Coerces an unknown value into a filtered list of non-empty strings. */
export function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((entry) => asString(entry)).filter(Boolean);
}

/** Adds a trimmed string argument when a value is present. */
function pushOptionalArg(args: string[], value: unknown): void {
  const candidate = asTrimmedString(value);
  if (candidate) {
    args.push(candidate);
  }
}

/** Builds `git fetch` arguments while omitting empty optional values. */
export function buildFetchArgs(params: RequestParams): string[] {
  const args = ['fetch'];
  const options = asRecord(params.opts);

  if (options.prune === true) {
    args.push('--prune');
  }

  pushOptionalArg(args, params.remote);
  pushOptionalArg(args, params.refspec);

  return args;
}

/** Builds `git push` arguments while omitting empty optional values. */
export function buildPushArgs(params: RequestParams): string[] {
  const args = ['push'];
  pushOptionalArg(args, params.remote);
  pushOptionalArg(args, params.refspec);
  return args;
}

/** Builds `git clone` arguments with recursive submodule initialization enabled. */
export function buildCloneArgs(params: RequestParams): string[] {
  const args = ['clone', '--recurse-submodules'];
  pushOptionalArg(args, params.url);
  pushOptionalArg(args, params.dest);
  return args;
}

/** Builds `git pull --ff-only` arguments while omitting empty optional values. */
export function buildPullFfOnlyArgs(params: RequestParams): string[] {
  const args = ['pull', '--ff-only'];
  pushOptionalArg(args, params.remote);
  pushOptionalArg(args, params.branch);
  return args;
}

/** Builds `git submodule update` arguments for pinned or remote-tracking updates. */
export function buildSubmoduleUpdateArgs(params: RequestParams): string[] {
  const args = ['submodule', 'update', '--init', '--recursive'];

  if (params.remote === true) {
    args.push('--remote');
  }

  const path = asTrimmedString(params.path);
  if (path) {
    args.push('--', path);
  }

  return args;
}

/** Parses `git status --porcelain=1 --branch -z -uall` output into OpenVCS payloads. */
export function parseStatusOutput(output: string): StatusParseResult {
  const records = output.split('\0').filter(Boolean);
  let ahead = 0;
  let behind = 0;
  let branchOnRemote = false;
  const files: StatusFileEntry[] = [];
  const summary: StatusSummary = {
    untracked: 0,
    modified: 0,
    staged: 0,
    conflicted: 0,
  };

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];

    if (record.startsWith('## ')) {
      const aheadMatch = record.match(/ahead\s+(\d+)/);
      const behindMatch = record.match(/behind\s+(\d+)/);
      ahead = aheadMatch ? Number(aheadMatch[1]) : 0;
      behind = behindMatch ? Number(behindMatch[1]) : 0;
      const trackingMatch = record.match(/\.\.\.[^\s]+/);
      branchOnRemote = !!trackingMatch;
      continue;
    }

    if (record.length < 4) {
      continue;
    }

    const x = record[0];
    const y = record[1];
    const payloadPath = record.slice(3);
    const renamedOrCopied = x === 'R' || x === 'C' || y === 'R' || y === 'C';
    let path = payloadPath;
    let oldPath: string | null = null;

    if (renamedOrCopied && index + 1 < records.length) {
      path = records[index + 1];
      oldPath = payloadPath;
      index += 1;
    }

    const conflicted =
      x === 'U' ||
      y === 'U' ||
      (x === 'A' && y === 'A') ||
      (x === 'D' && y === 'D');
    const staged = x !== ' ' && x !== '?';

    if (x === '?' || y === '?') {
      summary.untracked += 1;
    } else if (conflicted) {
      summary.conflicted += 1;
    } else {
      if (staged) {
        summary.staged += 1;
      }

      if (y !== ' ') {
        summary.modified += 1;
      }
    }

    files.push({
      path,
      old_path: oldPath,
      status: conflicted ? 'U' : `${x}${y}`.trim() || 'M',
      staged,
      resolved_conflict: false,
      hunks: [],
    });
  }

  return {
    summary,
    payload: {
      files,
      ahead,
      behind,
      branch_on_remote: branchOnRemote,
    },
  };
}

/** Applies submodule-specific status labels to known submodule paths. */
export function applySubmoduleStatusHints(
  parsed: StatusParseResult,
  submodulePaths: Iterable<string>,
): StatusParseResult {
  const knownPaths = new Set(
    Array.from(submodulePaths)
      .map((entry) => asTrimmedString(entry))
      .filter(Boolean),
  );

  if (knownPaths.size === 0) {
    return parsed;
  }

  return {
    ...parsed,
    payload: {
      ...parsed.payload,
      files: parsed.payload.files.map((file) => {
        const path = asTrimmedString(file.path);
        if (!knownPaths.has(path)) {
          return file;
        }

        return {
          ...file,
          status: 'S',
        };
      }),
    },
  };
}

/** Parses `git log` output into commit entries expected by the host. */
export function parseCommits(raw: string): CommitEntry[] {
  const records = raw
    .split('\u001e')
    .map((record) => record.trim())
    .filter(Boolean);

  return records.map((record) => {
    const [id, msg, author, meta, parent_oid = ''] = record.split('\u0000');
    return {
      id: asString(id),
      msg: asString(msg),
      author: asString(author),
      meta: asString(meta),
      parent_oid: parent_oid || undefined,
    };
  });
}
