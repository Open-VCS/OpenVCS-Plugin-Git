// Copyright © 2025-2026 OpenVCS Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  pluginError,
  type PluginRuntimeContext,
} from '@openvcs/sdk/runtime';
import type {
  RequestParams,
  StashEntry,
  StatusParseResult,
  VcsDelegates,
} from '@openvcs/sdk/types';

import {
  asNumber,
  asRecord,
  asString,
  asStringArray,
  asTrimmedString,
  buildFetchArgs,
  buildPullFfOnlyArgs,
  buildPushArgs,
  parseCommits,
  parseStatusOutput,
} from './plugin-helpers.js';
import type {
  GitCommandResult,
  GitSession,
  RunGitOptions,
} from './plugin-types.js';

/** Describes the Git runtime services consumed by the VCS delegates. */
export interface GitRuntimeDependencies {
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
    options?: RunGitOptions,
  ) => GitCommandResult;
}

/** Returns whether an active merge is currently in progress. */
function isMergeInProgress(
  session: GitSession,
  runGit: GitRuntimeDependencies['runGit'],
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
  runGitChecked: GitRuntimeDependencies['runGitChecked'],
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

/** Returns the required session worktree path for one request payload. */
function requireSessionPath(
  dependencies: GitRuntimeDependencies,
  sessionId: unknown,
): string {
  return dependencies.requireSession(sessionId).path;
}

/** Creates a commit and returns the resulting `HEAD` id. */
function createCommit(
  dependencies: GitRuntimeDependencies,
  cwd: string,
  params: RequestParams,
  errorCode: string,
): string {
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
    errorCode,
  );
  return dependencies.runGitChecked(
    ['rev-parse', 'HEAD'],
    cwd,
    'vcs-rev-parse-failed',
  ).stdout.trim();
}

/** Runs a git network command while emitting host progress events. */
function runNetworkCommand(
  dependencies: GitRuntimeDependencies,
  args: string[],
  cwd: string,
  errorCode: string,
  context: PluginRuntimeContext,
  sessionId: string,
  eventPhase: string,
): void {
  context.host.emitVcsEvent(sessionId, context.requestId, {
    type: 'progress',
    phase: eventPhase,
    detail: `running: git ${args.join(' ')}`,
  });
  dependencies.runGitChecked(args, cwd, errorCode);
}

/** Creates the Git-backed `vcs.*` delegate map consumed by the SDK runtime. */
export function createGitVcsDelegates(
  dependencies: GitRuntimeDependencies,
): VcsDelegates<PluginRuntimeContext> {
  return {
    async 'vcs.get_caps'() {
      return {
        commits: true,
        branches: true,
        tags: true,
        staging: true,
        push_pull: true,
        fast_forward: true,
      };
    },

    async 'vcs.open'(params) {
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
      return { session_id: sessionId };
    },

    async 'vcs.close'(params) {
      dependencies.closeSession(params.session_id);
      return null;
    },

    async 'vcs.clone_repo'(params, context) {
      const url = asTrimmedString(params.url);
      const destination = asTrimmedString(params.dest);

      if (!url || !destination) {
        throw pluginError('vcs-clone-invalid-args', 'url and dest are required');
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
        context.host.info(line);
      }

      return null;
    },

    async 'vcs.get_workdir'(params) {
      return requireSessionPath(dependencies, params.session_id);
    },

    async 'vcs.get_current_branch'(params) {
      const cwd = requireSessionPath(dependencies, params.session_id);
      const branch = dependencies.runGitChecked(
        ['rev-parse', '--abbrev-ref', 'HEAD'],
        cwd,
        'vcs-current-branch-failed',
      ).stdout.trim();
      return branch === 'HEAD' ? null : branch;
    },

    async 'vcs.list_branches'(params) {
      const cwd = requireSessionPath(dependencies, params.session_id);
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

      return raw
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
            kind: isRemote ? { type: 'Remote' as const, remote } : { type: 'Local' as const },
            current: headMark.trim() === '*',
          };
        });
    },

    async 'vcs.list_local_branches'(params) {
      const cwd = requireSessionPath(dependencies, params.session_id);
      const raw = dependencies.runGitChecked(
        ['for-each-ref', '--format=%(refname:short)', 'refs/heads'],
        cwd,
        'vcs-list-local-branches-failed',
      ).stdout;
      return raw.split(/\r?\n/g).map((line) => line.trim()).filter(Boolean);
    },

    async 'vcs.create_branch'(params) {
      const cwd = requireSessionPath(dependencies, params.session_id);
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

      return null;
    },

    async 'vcs.checkout_branch'(params) {
      const cwd = requireSessionPath(dependencies, params.session_id);
      dependencies.runGitChecked(
        ['checkout', asString(params.name)],
        cwd,
        'vcs-checkout-branch-failed',
      );
      return null;
    },

    async 'vcs.ensure_remote'(params) {
      const cwd = requireSessionPath(dependencies, params.session_id);
      const remoteName = asTrimmedString(params.name);
      const url = asTrimmedString(params.url);

      if (!remoteName || !url) {
        throw pluginError('vcs-ensure-remote-invalid', 'name and url are required');
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

      return null;
    },

    async 'vcs.list_remotes'(params) {
      const cwd = requireSessionPath(dependencies, params.session_id);
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

      return Array.from(remoteMap.entries()).map(([name, remoteUrl]) => ({
        name,
        url: remoteUrl,
      }));
    },

    async 'vcs.remove_remote'(params) {
      const cwd = requireSessionPath(dependencies, params.session_id);
      dependencies.runGitChecked(
        ['remote', 'remove', asString(params.name)],
        cwd,
        'vcs-remove-remote-failed',
      );
      return null;
    },

    async 'vcs.fetch'(params, context) {
      const cwd = requireSessionPath(dependencies, params.session_id);
      runNetworkCommand(
        dependencies,
        buildFetchArgs(params),
        cwd,
        'vcs-fetch-failed',
        context,
        asString(params.session_id),
        'fetch',
      );
      return null;
    },

    async 'vcs.push'(params, context) {
      const cwd = requireSessionPath(dependencies, params.session_id);
      runNetworkCommand(
        dependencies,
        buildPushArgs(params),
        cwd,
        'vcs-push-failed',
        context,
        asString(params.session_id),
        'push',
      );
      return null;
    },

    async 'vcs.pull_ff_only'(params, context) {
      const cwd = requireSessionPath(dependencies, params.session_id);
      runNetworkCommand(
        dependencies,
        buildPullFfOnlyArgs(params),
        cwd,
        'vcs-pull-failed',
        context,
        asString(params.session_id),
        'pull',
      );
      return null;
    },

    async 'vcs.commit'(params) {
      const cwd = requireSessionPath(dependencies, params.session_id);
      const paths = asStringArray(params.paths);
      if (paths.length > 0) {
        dependencies.runGitChecked(
          ['add', '--', ...paths],
          cwd,
          'vcs-add-paths-failed',
        );
      }

      return createCommit(dependencies, cwd, params, 'vcs-commit-failed');
    },

    async 'vcs.commit_index'(params) {
      const cwd = requireSessionPath(dependencies, params.session_id);
      return createCommit(dependencies, cwd, params, 'vcs-commit-index-failed');
    },

    async 'vcs.get_status_summary'(params) {
      const cwd = requireSessionPath(dependencies, params.session_id);
      return parseStatus(cwd, dependencies.runGitChecked).summary;
    },

    async 'vcs.get_status_payload'(params) {
      const cwd = requireSessionPath(dependencies, params.session_id);
      return parseStatus(cwd, dependencies.runGitChecked).payload;
    },

    async 'vcs.list_commits'(params) {
      const cwd = requireSessionPath(dependencies, params.session_id);
      const query = asRecord(params.query);
      const raw = dependencies.runGitChecked(
        buildListCommitsArgs(query),
        cwd,
        'vcs-log-failed',
      ).stdout;
      return parseCommits(raw);
    },

    async 'vcs.diff_file'(params) {
      const cwd = requireSessionPath(dependencies, params.session_id);
      const raw = dependencies.runGitChecked(
        ['diff', '--', asString(params.path)],
        cwd,
        'vcs-diff-file-failed',
      ).stdout;
      return raw.split(/\r?\n/g);
    },

    async 'vcs.diff_commit'(params) {
      const cwd = requireSessionPath(dependencies, params.session_id);
      const raw = dependencies.runGitChecked(
        ['show', '--format=', '--patch', asString(params.rev)],
        cwd,
        'vcs-diff-commit-failed',
      ).stdout;
      return raw.split(/\r?\n/g);
    },

    async 'vcs.get_conflict_details'(params) {
      const cwd = requireSessionPath(dependencies, params.session_id);
      return {
        path: asString(params.path),
        ours: null,
        theirs: null,
        base: null,
        binary: false,
        lfs_pointer: false,
      };
    },

    async 'vcs.checkout_conflict_side'(params) {
      const cwd = requireSessionPath(dependencies, params.session_id);
      const sideInput = asTrimmedString(params.side).toLowerCase();
      if (sideInput !== 'ours' && sideInput !== 'theirs') {
        throw pluginError(
          'vcs-invalid-params',
          "side must be 'ours' or 'theirs'",
        );
      }
      const side = sideInput === 'theirs' ? '--theirs' : '--ours';
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
      return null;
    },

    async 'vcs.write_merge_result'(params) {
      const cwd = requireSessionPath(dependencies, params.session_id);
      const path = asTrimmedString(params.path);
      const contentBase64 = asString(params.content_b64);
      writeFileSync(join(cwd, path), Buffer.from(contentBase64, 'base64'));
      dependencies.runGitChecked(
        ['add', '--', path],
        cwd,
        'vcs-write-merge-result-add-failed',
      );
      return null;
    },

    async 'vcs.stage_patch'(params) {
      const cwd = requireSessionPath(dependencies, params.session_id);
      dependencies.runGitChecked(
        ['apply', '--cached', '--unidiff-zero', '-'],
        cwd,
        'vcs-stage-patch-failed',
        { stdin: asString(params.patch) },
      );
      return null;
    },

    async 'vcs.discard_paths'(params) {
      const cwd = requireSessionPath(dependencies, params.session_id);
      const paths = asStringArray(params.paths);
      if (paths.length > 0) {
        dependencies.runGitChecked(
          ['restore', '--source=HEAD', '--staged', '--worktree', '--', ...paths],
          cwd,
          'vcs-discard-paths-failed',
        );
      }

      return null;
    },

    async 'vcs.apply_reverse_patch'(params) {
      const cwd = requireSessionPath(dependencies, params.session_id);
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

      return null;
    },

    async 'vcs.delete_branch'(params) {
      const cwd = requireSessionPath(dependencies, params.session_id);
      dependencies.runGitChecked(
        ['branch', params.force === true ? '-D' : '-d', asString(params.name)],
        cwd,
        'vcs-delete-branch-failed',
      );
      return null;
    },

    async 'vcs.rename_branch'(params) {
      const cwd = requireSessionPath(dependencies, params.session_id);
      dependencies.runGitChecked(
        ['branch', '-m', asString(params.old), asString(params.new)],
        cwd,
        'vcs-rename-branch-failed',
      );
      return null;
    },

    async 'vcs.merge_into_current'(params) {
      const cwd = requireSessionPath(dependencies, params.session_id);
      const args = ['merge', asString(params.name)];
      const messageText = asTrimmedString(params.message);

      if (messageText) {
        args.push('-m', messageText);
      }

      dependencies.runGitChecked(args, cwd, 'vcs-merge-failed');
      return null;
    },

    async 'vcs.merge_abort'(params) {
      const cwd = requireSessionPath(dependencies, params.session_id);
      dependencies.runGitChecked(
        ['merge', '--abort'],
        cwd,
        'vcs-merge-abort-failed',
      );
      return null;
    },

    async 'vcs.merge_continue'(params) {
      const cwd = requireSessionPath(dependencies, params.session_id);
      dependencies.runGitChecked(
        ['merge', '--continue'],
        cwd,
        'vcs-merge-continue-failed',
      );
      return null;
    },

    async 'vcs.is_merge_in_progress'(params) {
      const session = dependencies.requireSession(params.session_id);
      return isMergeInProgress(session, dependencies.runGit);
    },

    async 'vcs.set_branch_upstream'(params) {
      const cwd = requireSessionPath(dependencies, params.session_id);
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
      return null;
    },

    async 'vcs.get_branch_upstream'(params) {
      const cwd = requireSessionPath(dependencies, params.session_id);
      const output = dependencies.runGit(
        ['rev-parse', '--abbrev-ref', `${asString(params.branch)}@{upstream}`],
        cwd,
      );
      if (output.status === 0) return output.stdout.trim();
      return null;
    },

    async 'vcs.hard_reset_head'(params) {
      const cwd = requireSessionPath(dependencies, params.session_id);
      dependencies.runGitChecked(
        ['reset', '--hard', 'HEAD'],
        cwd,
        'vcs-hard-reset-failed',
      );
      return null;
    },

    async 'vcs.reset_soft_to'(params) {
      const cwd = requireSessionPath(dependencies, params.session_id);
      dependencies.runGitChecked(
        ['reset', '--soft', asString(params.rev)],
        cwd,
        'vcs-reset-soft-failed',
      );
      return null;
    },

    async 'vcs.get_identity'(params) {
      const cwd = requireSessionPath(dependencies, params.session_id);
      const name = dependencies.runGit(
        ['config', '--get', 'user.name'],
        cwd,
      ).stdout.trim();
      const email = dependencies.runGit(
        ['config', '--get', 'user.email'],
        cwd,
      ).stdout.trim();

      if (!name && !email) {
        return null;
      }

      return { name, email };
    },

    async 'vcs.set_identity_local'(params) {
      const cwd = requireSessionPath(dependencies, params.session_id);
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
      return null;
    },

    async 'vcs.list_stashes'(params) {
      const cwd = requireSessionPath(dependencies, params.session_id);
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
      return entries;
    },

    async 'vcs.stash_push'(params) {
      const cwd = requireSessionPath(dependencies, params.session_id);
      const args = ['stash', 'push'];
      if (params.include_untracked === true) {
        args.push('--include-untracked');
      }

      const messageText = asTrimmedString(params.message);
      if (messageText) {
        args.push('-m', messageText);
      }

      dependencies.runGitChecked(args, cwd, 'vcs-stash-push-failed');
      return dependencies.runGitChecked(
        ['stash', 'list', '-n', '1', '--pretty=format:%gd'],
        cwd,
        'vcs-stash-push-failed',
      ).stdout.trim();
    },

    async 'vcs.stash_apply'(params) {
      const cwd = requireSessionPath(dependencies, params.session_id);
      dependencies.runGitChecked(
        ['stash', 'apply', asString(params.selector)],
        cwd,
        'vcs-stash-apply-failed',
      );
      return null;
    },

    async 'vcs.stash_pop'(params) {
      const cwd = requireSessionPath(dependencies, params.session_id);
      dependencies.runGitChecked(
        ['stash', 'pop', asString(params.selector)],
        cwd,
        'vcs-stash-pop-failed',
      );
      return null;
    },

    async 'vcs.stash_drop'(params) {
      const cwd = requireSessionPath(dependencies, params.session_id);
      dependencies.runGitChecked(
        ['stash', 'drop', asString(params.selector)],
        cwd,
        'vcs-stash-drop-failed',
      );
      return null;
    },

    async 'vcs.stash_show'(params) {
      const cwd = requireSessionPath(dependencies, params.session_id);
      return dependencies.runGitChecked(
        ['stash', 'show', '-p', asString(params.selector)],
        cwd,
        'vcs-stash-show-failed',
      ).stdout;
    },

    async 'vcs.cherry_pick'(params) {
      const cwd = requireSessionPath(dependencies, params.session_id);
      dependencies.runGitChecked(
        ['cherry-pick', asString(params.commit)],
        cwd,
        'vcs-cherry-pick-failed',
      );
      return null;
    },

    async 'vcs.revert_commit'(params) {
      const cwd = requireSessionPath(dependencies, params.session_id);
      const args = ['revert'];
      if (params.no_edit === true) {
        args.push('--no-edit');
      }

      args.push(asString(params.commit));
      dependencies.runGitChecked(args, cwd, 'vcs-revert-failed');
      return null;
    },
  };
}
