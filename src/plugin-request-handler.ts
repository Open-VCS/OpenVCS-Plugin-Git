// Copyright © 2025-2026 OpenVCS Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  asNumber,
  asRecord,
  asString,
  asStringArray,
  asTrimmedString,
  buildFetchArgs,
  buildPullFfOnlyArgs,
  buildPushArgs,
  isPluginFailure,
  parseCommits,
  parseStatusOutput,
  pluginError,
} from './plugin-helpers.js';
import type {
  GitCommandResult,
  GitSession,
  JsonRpcId,
  JsonRpcRequest,
  RequestParams,
  RunGitOptions,
  StashEntry,
  StatusParseResult,
} from './plugin-types.js';

/** Describes the runtime services used while handling one JSON-RPC request. */
export interface RequestHandlerDependencies {
  /** Stores the protocol version returned by `plugin.initialize`. */
  protocolVersion: number;
  /** Emits a JSON-RPC success response. */
  sendResult: (id: JsonRpcId, result: unknown) => void;
  /** Emits a JSON-RPC error response. */
  sendError: (
    id: JsonRpcId,
    code: number,
    message: string,
    data?: unknown,
  ) => void;
  /** Emits a host log notification. */
  emitHostLog: (level: 'error' | 'info', message: string) => void;
  /** Allocates a new repository session and returns its id. */
  allocateSession: (session: GitSession) => string;
  /** Removes a repository session by id. */
  closeSession: (sessionId: unknown) => void;
  /** Resolves an active session or raises a plugin error. */
  requireSession: (sessionId: unknown) => GitSession;
  /** Executes a git command without automatic error translation. */
  runGit: (
    args: string[],
    cwd: string,
    options?: RunGitOptions,
  ) => GitCommandResult;
  /** Executes a git command and translates failures into plugin errors. */
  runGitChecked: (
    args: string[],
    cwd: string,
    errorCode: string,
    requestId?: JsonRpcId | null,
    sessionId?: string | null,
    eventPhase?: string | null,
    options?: RunGitOptions,
  ) => GitCommandResult;
}

/** Returns whether an active merge is currently in progress. */
function isMergeInProgress(
  session: GitSession,
  runGit: RequestHandlerDependencies['runGit'],
): boolean {
  const output = runGit(
    ['rev-parse', '--verify', '-q', 'MERGE_HEAD'],
    session.path,
  );
  return output.status === 0;
}

/** Reads and parses repository status for one session worktree. */
function parseStatus(
  cwd: string,
  runGitChecked: RequestHandlerDependencies['runGitChecked'],
): StatusParseResult {
  const output = runGitChecked(
    ['status', '--porcelain=1', '--branch', '-z', '-uall'],
    cwd,
    'git-status-failed',
  ).stdout;
  return parseStatusOutput(output);
}

/** Builds the `git log` command arguments for one list-commits request. */
function buildListCommitsArgs(query: RequestParams): string[] {
  const args = [
    'log',
    `--skip=${asNumber(query.skip, 0)}`,
    `--max-count=${asNumber(query.limit, 200)}`,
    '--pretty=format:%H%x1f%s%x1f%an%x1f%ad%x1e',
    '--date=iso',
  ];

  if (query.topo_order === true) {
    args.push('--topo-order');
  }

  if (query.include_merges !== true) {
    args.push('--no-merges');
  }

  const authorContains = asTrimmedString(query.author_contains);
  if (authorContains) {
    args.push(`--author=${authorContains}`);
  }

  const sinceUtc = asTrimmedString(query.since_utc);
  if (sinceUtc) {
    args.push(`--since=${sinceUtc}`);
  }

  const untilUtc = asTrimmedString(query.until_utc);
  if (untilUtc) {
    args.push(`--until=${untilUtc}`);
  }

  args.push(asTrimmedString(query.rev) || 'HEAD');

  const path = asTrimmedString(query.path);
  if (path) {
    args.push('--', path);
  }

  return args;
}

/** Handles one JSON-RPC request from the host. */
export async function handleMessage(
  message: JsonRpcRequest,
  dependencies: RequestHandlerDependencies,
): Promise<void> {
  const id = message.id;
  const method = asTrimmedString(message.method);
  const params = asRecord(message.params);

  if (!method || (typeof id !== 'number' && typeof id !== 'string')) {
    return;
  }

  const requestId = id;

  try {
    switch (method) {
      case 'plugin.initialize': {
        dependencies.sendResult(id, {
          protocol_version: dependencies.protocolVersion,
          implements: { plugin: true, vcs: true },
        });
        return;
      }

      case 'plugin.init':
      case 'plugin.deinit':
      case 'plugin.handle_action':
      case 'plugin.settings.on_apply':
      case 'plugin.settings.on_reset': {
        dependencies.sendResult(id, null);
        return;
      }

      case 'plugin.get_menus': {
        dependencies.sendResult(id, []);
        return;
      }

      case 'plugin.settings.defaults': {
        dependencies.sendResult(id, []);
        return;
      }

      case 'plugin.settings.on_load':
      case 'plugin.settings.on_save': {
        dependencies.sendResult(
          id,
          Array.isArray(params.values) ? params.values : [],
        );
        return;
      }

      case 'vcs.get_caps': {
        dependencies.sendResult(id, {
          commits: true,
          branches: true,
          tags: true,
          staging: true,
          push_pull: true,
          fast_forward: true,
        });
        return;
      }

      case 'vcs.open': {
        const repoPath = asTrimmedString(params.path);
        if (!repoPath) {
          throw pluginError('vcs-open-invalid-path', 'path is required');
        }

        dependencies.runGitChecked(
          ['rev-parse', '--git-dir'],
          repoPath,
          'vcs-open-not-repository',
        );
        const sessionId = dependencies.allocateSession({ path: repoPath });
        dependencies.sendResult(id, { session_id: sessionId });
        return;
      }

      case 'vcs.close': {
        dependencies.closeSession(params.session_id);
        dependencies.sendResult(id, null);
        return;
      }

      case 'vcs.clone_repo': {
        const url = asTrimmedString(params.url);
        const destination = asTrimmedString(params.dest);

        if (!url || !destination) {
          throw pluginError(
            'vcs-clone-invalid-args',
            'url and dest are required',
          );
        }

        const output = dependencies.runGitChecked(
          ['clone', url, destination],
          process.cwd(),
          'vcs-clone-failed',
        );
        const lines = `${output.stdout}\n${output.stderr}`
          .split(/\r?\n/g)
          .map((line) => line.trim())
          .filter(Boolean);

        for (const line of lines) {
          dependencies.emitHostLog('info', line);
        }

        dependencies.sendResult(id, null);
        return;
      }

      default:
        break;
    }

    const session = dependencies.requireSession(params.session_id);
    const cwd = session.path;

    switch (method) {
      case 'vcs.get_workdir': {
        dependencies.sendResult(id, cwd);
        return;
      }

      case 'vcs.get_current_branch': {
        const branch = dependencies.runGitChecked(
          ['rev-parse', '--abbrev-ref', 'HEAD'],
          cwd,
          'vcs-current-branch-failed',
        ).stdout.trim();
        dependencies.sendResult(id, branch === 'HEAD' ? null : branch);
        return;
      }

      case 'vcs.list_branches': {
        const raw = dependencies.runGitChecked(
          [
            'for-each-ref',
            '--format=%(refname:short)\t%(refname)\t%(HEAD)',
            'refs/heads',
            'refs/remotes',
          ],
          cwd,
          'vcs-list-branches-failed',
        ).stdout;
        const branches = raw
          .split(/\r?\n/g)
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) => {
            const [name = '', fullRef = '', headMark = ''] = line.split('\t');
            const isRemote = fullRef.startsWith('refs/remotes/');
            const remote = isRemote ? name.split('/')[0] ?? null : null;

            return {
              name,
              full_ref: fullRef,
              kind: isRemote
                ? { type: 'Remote', remote }
                : { type: 'Local' },
              current: headMark.trim() === '*',
            };
          });

        dependencies.sendResult(id, branches);
        return;
      }

      case 'vcs.list_local_branches': {
        const raw = dependencies.runGitChecked(
          ['for-each-ref', '--format=%(refname:short)', 'refs/heads'],
          cwd,
          'vcs-list-local-branches-failed',
        ).stdout;
        dependencies.sendResult(
          id,
          raw.split(/\r?\n/g).map((line) => line.trim()).filter(Boolean),
        );
        return;
      }

      case 'vcs.create_branch': {
        const branchName = asString(params.name);
        dependencies.runGitChecked(
          ['branch', branchName],
          cwd,
          'vcs-create-branch-failed',
        );

        if (params.checkout === true) {
          dependencies.runGitChecked(
            ['checkout', branchName],
            cwd,
            'vcs-checkout-branch-failed',
          );
        }

        dependencies.sendResult(id, null);
        return;
      }

      case 'vcs.checkout_branch': {
        dependencies.runGitChecked(
          ['checkout', asString(params.name)],
          cwd,
          'vcs-checkout-branch-failed',
        );
        dependencies.sendResult(id, null);
        return;
      }

      case 'vcs.ensure_remote': {
        const remoteName = asTrimmedString(params.name);
        const url = asTrimmedString(params.url);

        if (!remoteName || !url) {
          throw pluginError(
            'vcs-ensure-remote-invalid',
            'name and url are required',
          );
        }

        const probe = dependencies.runGit(['remote', 'get-url', remoteName], cwd);
        if (probe.status === 0) {
          dependencies.runGitChecked(
            ['remote', 'set-url', remoteName, url],
            cwd,
            'vcs-set-remote-url-failed',
          );
        } else {
          dependencies.runGitChecked(
            ['remote', 'add', remoteName, url],
            cwd,
            'vcs-add-remote-failed',
          );
        }

        dependencies.sendResult(id, null);
        return;
      }

      case 'vcs.list_remotes': {
        const raw = dependencies.runGitChecked(
          ['remote', '-v'],
          cwd,
          'vcs-list-remotes-failed',
        ).stdout;
        const remoteMap = new Map<string, string>();

        for (const line of raw.split(/\r?\n/g)) {
          const trimmedLine = line.trim();
          if (!trimmedLine) {
            continue;
          }

          const match = trimmedLine.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
          if (!match) {
            continue;
          }

          remoteMap.set(match[1], match[2]);
        }

        dependencies.sendResult(
          id,
          Array.from(remoteMap.entries()).map(([name, remoteUrl]) => ({
            name,
            url: remoteUrl,
          })),
        );
        return;
      }

      case 'vcs.remove_remote': {
        dependencies.runGitChecked(
          ['remote', 'remove', asString(params.name)],
          cwd,
          'vcs-remove-remote-failed',
        );
        dependencies.sendResult(id, null);
        return;
      }

      case 'vcs.fetch':
      case 'vcs.fetch_with_options': {
        dependencies.runGitChecked(
          buildFetchArgs(params),
          cwd,
          'vcs-fetch-failed',
          requestId,
          asString(params.session_id),
          'fetch',
        );
        dependencies.sendResult(id, null);
        return;
      }

      case 'vcs.push': {
        dependencies.runGitChecked(
          buildPushArgs(params),
          cwd,
          'vcs-push-failed',
          requestId,
          asString(params.session_id),
          'push',
        );
        dependencies.sendResult(id, null);
        return;
      }

      case 'vcs.pull_ff_only': {
        dependencies.runGitChecked(
          buildPullFfOnlyArgs(params),
          cwd,
          'vcs-pull-failed',
          requestId,
          asString(params.session_id),
          'pull',
        );
        dependencies.sendResult(id, null);
        return;
      }

      case 'vcs.commit': {
        const paths = asStringArray(params.paths);
        if (paths.length > 0) {
          dependencies.runGitChecked(
            ['add', '--', ...paths],
            cwd,
            'vcs-add-paths-failed',
          );
        }

        dependencies.runGitChecked(
          [
            '-c',
            `user.name=${asString(params.name)}`,
            '-c',
            `user.email=${asString(params.email)}`,
            'commit',
            '-m',
            asString(params.message),
          ],
          cwd,
          'vcs-commit-failed',
        );
        const commitId = dependencies.runGitChecked(
          ['rev-parse', 'HEAD'],
          cwd,
          'vcs-rev-parse-failed',
        ).stdout.trim();
        dependencies.sendResult(id, commitId);
        return;
      }

      case 'vcs.commit_index': {
        dependencies.runGitChecked(
          [
            '-c',
            `user.name=${asString(params.name)}`,
            '-c',
            `user.email=${asString(params.email)}`,
            'commit',
            '-m',
            asString(params.message),
          ],
          cwd,
          'vcs-commit-index-failed',
        );
        const commitId = dependencies.runGitChecked(
          ['rev-parse', 'HEAD'],
          cwd,
          'vcs-rev-parse-failed',
        ).stdout.trim();
        dependencies.sendResult(id, commitId);
        return;
      }

      case 'vcs.get_status_summary': {
        dependencies.sendResult(
          id,
          parseStatus(cwd, dependencies.runGitChecked).summary,
        );
        return;
      }

      case 'vcs.get_status_payload': {
        dependencies.sendResult(
          id,
          parseStatus(cwd, dependencies.runGitChecked).payload,
        );
        return;
      }

      case 'vcs.list_commits': {
        const query = asRecord(params.query);
        const raw = dependencies.runGitChecked(
          buildListCommitsArgs(query),
          cwd,
          'vcs-log-failed',
        ).stdout;
        dependencies.sendResult(id, parseCommits(raw));
        return;
      }

      case 'vcs.diff_file': {
        const raw = dependencies.runGitChecked(
          ['diff', '--', asString(params.path)],
          cwd,
          'vcs-diff-file-failed',
        ).stdout;
        dependencies.sendResult(id, raw.split(/\r?\n/g));
        return;
      }

      case 'vcs.diff_commit': {
        const raw = dependencies.runGitChecked(
          ['show', '--format=', '--patch', asString(params.rev)],
          cwd,
          'vcs-diff-commit-failed',
        ).stdout;
        dependencies.sendResult(id, raw.split(/\r?\n/g));
        return;
      }

      case 'vcs.get_conflict_details': {
        dependencies.sendResult(id, {
          path: asString(params.path),
          ours: null,
          theirs: null,
          base: null,
          binary: false,
          lfs_pointer: false,
        });
        return;
      }

      case 'vcs.checkout_conflict_side': {
        const side =
          asTrimmedString(params.side).toLowerCase() === 'theirs'
            ? '--theirs'
            : '--ours';
        const path = asString(params.path);
        dependencies.runGitChecked(
          ['checkout', side, '--', path],
          cwd,
          'vcs-checkout-conflict-side-failed',
        );
        dependencies.runGitChecked(
          ['add', '--', path],
          cwd,
          'vcs-checkout-conflict-side-add-failed',
        );
        dependencies.sendResult(id, null);
        return;
      }

      case 'vcs.write_merge_result': {
        const path = asTrimmedString(params.path);
        const contentBase64 = asString(params.content_b64);
        writeFileSync(join(cwd, path), Buffer.from(contentBase64, 'base64'));
        dependencies.runGitChecked(
          ['add', '--', path],
          cwd,
          'vcs-write-merge-result-add-failed',
        );
        dependencies.sendResult(id, null);
        return;
      }

      case 'vcs.stage_patch': {
        dependencies.runGitChecked(
          ['apply', '--cached', '--unidiff-zero', '-'],
          cwd,
          'vcs-stage-patch-failed',
          null,
          null,
          null,
          { stdin: asString(params.patch) },
        );
        dependencies.sendResult(id, null);
        return;
      }

      case 'vcs.discard_paths': {
        const paths = asStringArray(params.paths);
        if (paths.length > 0) {
          dependencies.runGitChecked(
            ['restore', '--source=HEAD', '--staged', '--worktree', '--', ...paths],
            cwd,
            'vcs-discard-paths-failed',
          );
        }

        dependencies.sendResult(id, null);
        return;
      }

      case 'vcs.apply_reverse_patch': {
        const output = dependencies.runGit(
          ['apply', '-R', '--unidiff-zero', '-'],
          cwd,
          { stdin: asString(params.patch) },
        );

        if (output.status !== 0) {
          throw pluginError(
            'vcs-apply-reverse-patch-failed',
            output.stderr.trim() || output.stdout.trim(),
          );
        }

        dependencies.sendResult(id, null);
        return;
      }

      case 'vcs.delete_branch': {
        dependencies.runGitChecked(
          ['branch', params.force === true ? '-D' : '-d', asString(params.name)],
          cwd,
          'vcs-delete-branch-failed',
        );
        dependencies.sendResult(id, null);
        return;
      }

      case 'vcs.rename_branch': {
        dependencies.runGitChecked(
          ['branch', '-m', asString(params.old), asString(params.new)],
          cwd,
          'vcs-rename-branch-failed',
        );
        dependencies.sendResult(id, null);
        return;
      }

      case 'vcs.merge_into_current': {
        const args = ['merge', asString(params.name)];
        const messageText = asTrimmedString(params.message);

        if (messageText) {
          args.push('-m', messageText);
        }

        dependencies.runGitChecked(args, cwd, 'vcs-merge-failed');
        dependencies.sendResult(id, null);
        return;
      }

      case 'vcs.merge_abort': {
        dependencies.runGitChecked(
          ['merge', '--abort'],
          cwd,
          'vcs-merge-abort-failed',
        );
        dependencies.sendResult(id, null);
        return;
      }

      case 'vcs.merge_continue': {
        dependencies.runGitChecked(
          ['merge', '--continue'],
          cwd,
          'vcs-merge-continue-failed',
        );
        dependencies.sendResult(id, null);
        return;
      }

      case 'vcs.is_merge_in_progress': {
        dependencies.sendResult(
          id,
          isMergeInProgress(session, dependencies.runGit),
        );
        return;
      }

      case 'vcs.set_branch_upstream': {
        dependencies.runGitChecked(
          [
            'branch',
            '--set-upstream-to',
            asString(params.upstream),
            asString(params.branch),
          ],
          cwd,
          'vcs-set-upstream-failed',
        );
        dependencies.sendResult(id, null);
        return;
      }

      case 'vcs.get_branch_upstream': {
        const output = dependencies.runGit(
          ['rev-parse', '--abbrev-ref', `${asString(params.branch)}@{upstream}`],
          cwd,
        );
        dependencies.sendResult(id, output.status === 0 ? output.stdout.trim() : null);
        return;
      }

      case 'vcs.hard_reset_head': {
        dependencies.runGitChecked(
          ['reset', '--hard', 'HEAD'],
          cwd,
          'vcs-hard-reset-failed',
        );
        dependencies.sendResult(id, null);
        return;
      }

      case 'vcs.reset_soft_to': {
        dependencies.runGitChecked(
          ['reset', '--soft', asString(params.rev)],
          cwd,
          'vcs-reset-soft-failed',
        );
        dependencies.sendResult(id, null);
        return;
      }

      case 'vcs.get_identity': {
        const name = dependencies.runGit(['config', '--get', 'user.name'], cwd).stdout.trim();
        const email = dependencies.runGit(['config', '--get', 'user.email'], cwd).stdout.trim();

        if (!name && !email) {
          dependencies.sendResult(id, null);
        } else {
          dependencies.sendResult(id, { name, email });
        }

        return;
      }

      case 'vcs.set_identity_local': {
        dependencies.runGitChecked(
          ['config', 'user.name', asString(params.name)],
          cwd,
          'vcs-set-name-failed',
        );
        dependencies.runGitChecked(
          ['config', 'user.email', asString(params.email)],
          cwd,
          'vcs-set-email-failed',
        );
        dependencies.sendResult(id, null);
        return;
      }

      case 'vcs.list_stashes': {
        const raw = dependencies.runGitChecked(
          ['stash', 'list', '--pretty=format:%gd%x1f%s%x1e'],
          cwd,
          'vcs-stash-list-failed',
        ).stdout;
        const entries: StashEntry[] = raw
          .split('\u001e')
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) => {
            const [selector = '', msg = ''] = line.split('\u001f');
            return { selector, msg, meta: '' };
          });
        dependencies.sendResult(id, entries);
        return;
      }

      case 'vcs.stash_push': {
        const args = ['stash', 'push'];
        if (params.include_untracked === true) {
          args.push('--include-untracked');
        }

        const messageText = asTrimmedString(params.message);
        if (messageText) {
          args.push('-m', messageText);
        }

        dependencies.runGitChecked(args, cwd, 'vcs-stash-push-failed');
        const selector = dependencies.runGitChecked(
          ['stash', 'list', '-n', '1', '--pretty=format:%gd'],
          cwd,
          'vcs-stash-push-failed',
        ).stdout.trim();
        dependencies.sendResult(id, selector);
        return;
      }

      case 'vcs.stash_apply': {
        dependencies.runGitChecked(
          ['stash', 'apply', asString(params.selector)],
          cwd,
          'vcs-stash-apply-failed',
        );
        dependencies.sendResult(id, null);
        return;
      }

      case 'vcs.stash_pop': {
        dependencies.runGitChecked(
          ['stash', 'pop', asString(params.selector)],
          cwd,
          'vcs-stash-pop-failed',
        );
        dependencies.sendResult(id, null);
        return;
      }

      case 'vcs.stash_drop': {
        dependencies.runGitChecked(
          ['stash', 'drop', asString(params.selector)],
          cwd,
          'vcs-stash-drop-failed',
        );
        dependencies.sendResult(id, null);
        return;
      }

      case 'vcs.stash_show': {
        const diff = dependencies.runGitChecked(
          ['stash', 'show', '-p', asString(params.selector)],
          cwd,
          'vcs-stash-show-failed',
        ).stdout;
        dependencies.sendResult(id, diff);
        return;
      }

      case 'vcs.cherry_pick': {
        dependencies.runGitChecked(
          ['cherry-pick', asString(params.commit)],
          cwd,
          'vcs-cherry-pick-failed',
        );
        dependencies.sendResult(id, null);
        return;
      }

      case 'vcs.revert_commit': {
        const args = ['revert'];
        if (params.no_edit === true) {
          args.push('--no-edit');
        }

        args.push(asString(params.commit));
        dependencies.runGitChecked(args, cwd, 'vcs-revert-failed');
        dependencies.sendResult(id, null);
        return;
      }

      default:
        throw pluginError(
          'rpc-method-not-found',
          `method '${method}' is not implemented`,
        );
    }
  } catch (error) {
    if (isPluginFailure(error)) {
      dependencies.sendError(id, error.code, error.message, error.data);
      return;
    }

    const messageText =
      error instanceof Error ? error.message : asString(error || 'unknown error');
    dependencies.sendError(id, -32002, messageText, {
      code: 'plugin-internal-error',
      message: messageText,
    });
  }
}
