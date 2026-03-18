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
  VcsDelegates,
  VcsBranchKind,
  VcsRemoteEntry,
} from '@openvcs/sdk/types';

import { asNumber, asRecord, asString, asTrimmedString, asStringArray } from './plugin-helpers.js';
import type { GitSession } from './plugin-types.js';
import { GitCommand } from './git.js';

/** Describes the Git runtime services consumed by the VCS delegates. */
export interface GitRuntimeDependencies {
  /** Allocates a new repository session and returns its id. */
  allocateSession: (session: GitSession) => string;
  /** Removes a repository session by id. */
  closeSession: (sessionId: unknown) => void;
  /** Resolves an active session or raises a plugin error. */
  requireSession: (sessionId: unknown) => GitSession;
  /** Creates a GitCommand instance for a given repository path. */
  createGitCommand: (cwd: string) => GitCommand;
}

/** Returns the required session worktree path for one request payload. */
function requireSessionPath(
  dependencies: GitRuntimeDependencies,
  sessionId: unknown,
): string {
  return dependencies.requireSession(sessionId).path;
}

/** Returns a GitCommand instance for a required session. */
function requireGit(dependencies: GitRuntimeDependencies, sessionId: unknown): GitCommand {
  const cwd = requireSessionPath(dependencies, sessionId);
  return dependencies.createGitCommand(cwd);
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

      const git = dependencies.createGitCommand(repoPath);
      git.runChecked(['rev-parse', '--git-dir'], 'vcs-open-not-repository');
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

      const git = dependencies.createGitCommand(process.cwd());
      const output = git.runChecked(['clone', url, destination], 'vcs-clone-failed');
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
      const git = requireGit(dependencies, params.session_id);
      const branch = git.currentBranch();
      return branch === 'HEAD' ? null : branch;
    },

    async 'vcs.list_branches'(params) {
      const git = requireGit(dependencies, params.session_id);
      const raw = git.runChecked(
        [
          'for-each-ref',
          '--format=%(refname:short)\t%(refname)\t%(HEAD)',
          'refs/heads',
          'refs/remotes',
        ],
        'vcs-list-branches-failed',
      );

      return raw.stdout
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
            kind: (isRemote ? 'remote' : 'local') as unknown as VcsBranchKind,
            current: headMark === '*',
            remote,
          };
        });
    },

    async 'vcs.list_local_branches'(params) {
      const git = requireGit(dependencies, params.session_id);
      const raw = git.runChecked(
        ['for-each-ref', '--format=%(refname:short)', 'refs/heads/'],
        'vcs-list-branches-failed',
      );
      return raw.stdout
        .split('\n')
        .map((b) => b.trim())
        .filter(Boolean);
    },

    async 'vcs.create_branch'(params) {
      const git = requireGit(dependencies, params.session_id);
      git.createBranch(asTrimmedString(params.name));
      return null;
    },

    async 'vcs.checkout_branch'(params) {
      const git = requireGit(dependencies, params.session_id);
      git.checkoutBranch(asTrimmedString(params.name));
      return null;
    },

    async 'vcs.ensure_remote'(params) {
      const git = requireGit(dependencies, params.session_id);
      const name = asTrimmedString(params.name);
      const url = asTrimmedString(params.url);
      if (!name || !url) {
        throw pluginError('vcs-remote-invalid-args', 'name and url are required');
      }
      git.ensureRemote(name, url);
      return null;
    },

    async 'vcs.list_remotes'(params) {
      const git = requireGit(dependencies, params.session_id);
      const result = git.listRemotes();
      return result.remotes.map((r) => ({
        name: r.name,
        url: r.fetch || r.push,
      }));
    },

    async 'vcs.remove_remote'(params) {
      const git = requireGit(dependencies, params.session_id);
      git.removeRemote(asTrimmedString(params.name));
      return null;
    },

    async 'vcs.fetch'(params, context) {
      const git = requireGit(dependencies, params.session_id);
      const options = asRecord(params.opts);
      git.fetch({
        remote: asTrimmedString(params.remote),
        refspec: asTrimmedString(params.refspec),
        opts: { prune: options.prune === true },
      });
      return null;
    },

    async 'vcs.push'(params, context) {
      const git = requireGit(dependencies, params.session_id);
      git.push({
        remote: asTrimmedString(params.remote),
        refspec: asTrimmedString(params.refspec),
      });
      return null;
    },

    async 'vcs.pull_ff_only'(params, context) {
      const git = requireGit(dependencies, params.session_id);
      git.pull({
        remote: asTrimmedString(params.remote),
        branch: asTrimmedString(params.branch),
      });
      return null;
    },

    async 'vcs.commit'(params) {
      const git = requireGit(dependencies, params.session_id);
      const result = git.runChecked(['rev-parse', 'HEAD'], 'git-commit-failed');
      git.commit(asTrimmedString(params.message));
      return result.stdout.trim();
    },

    async 'vcs.commit_index'(params) {
      const git = requireGit(dependencies, params.session_id);
      const result = git.runChecked(['rev-parse', 'HEAD'], 'git-commit-failed');
      git.commitIndex(
        asTrimmedString(params.message),
        asTrimmedString(params.name),
        asTrimmedString(params.email),
        asStringArray(params.paths),
      );
      return result.stdout.trim();
    },

    async 'vcs.get_status_summary'(params) {
      const git = requireGit(dependencies, params.session_id);
      const status = git.status();
      return status.summary;
    },

    async 'vcs.get_status_payload'(params) {
      const git = requireGit(dependencies, params.session_id);
      const status = git.status();
      return status.payload;
    },

    async 'vcs.list_commits'(params) {
      const git = requireGit(dependencies, params.session_id);
      const options = asRecord(params.opts);
      const result = git.listCommits({
        branch: asTrimmedString(options.branch),
        parent: asNumber(options.parent, 0) || undefined,
        path: asTrimmedString(options.path),
      });
      return result.commits;
    },

    async 'vcs.diff_file'(params) {
      const git = requireGit(dependencies, params.session_id);
      const result = git.diffFile(asTrimmedString(params.path));
      return result.split('\n');
    },

    async 'vcs.diff_commit'(params) {
      const git = requireGit(dependencies, params.session_id);
      const result = git.diffCommit(asTrimmedString(params.commit));
      return result.split('\n');
    },

    async 'vcs.get_conflict_details'(params) {
      const git = requireGit(dependencies, params.session_id);
      return git.getConflictDetails(asTrimmedString(params.path));
    },

    async 'vcs.checkout_conflict_side'(params) {
      const git = requireGit(dependencies, params.session_id);
      const side = asTrimmedString(params.side);
      if (side !== 'ours' && side !== 'theirs') {
        throw pluginError('vcs-invalid-side', 'side must be "ours" or "theirs"');
      }
      git.checkoutConflictSide(asTrimmedString(params.path), side);
      return null;
    },

    async 'vcs.write_merge_result'(params) {
      const git = requireGit(dependencies, params.session_id);
      git.writeMergeResult(asTrimmedString(params.path), asString(params.content));
      return null;
    },

    async 'vcs.stage_patch'(params) {
      const git = requireGit(dependencies, params.session_id);
      git.stagePatch(asString(params.patch));
      return null;
    },

    async 'vcs.discard_paths'(params) {
      const git = requireGit(dependencies, params.session_id);
      const paths = asStringArray(params.paths);
      if (paths.length === 0) {
        return null;
      }
      git.runChecked(['checkout', '--', ...paths], 'git-discard-paths-failed');
      return null;
    },

    async 'vcs.apply_reverse_patch'(params) {
      const git = requireGit(dependencies, params.session_id);
      git.applyReversePatch(asString(params.patch));
      return null;
    },

    async 'vcs.delete_branch'(params) {
      const git = requireGit(dependencies, params.session_id);
      git.deleteBranch(asTrimmedString(params.name));
      return null;
    },

    async 'vcs.rename_branch'(params) {
      const git = requireGit(dependencies, params.session_id);
      git.renameBranch(asTrimmedString(params.name), asTrimmedString(params.new_name));
      return null;
    },

    async 'vcs.merge_into_current'(params) {
      const git = requireGit(dependencies, params.session_id);
      git.mergeIntoCurrent(asTrimmedString(params.branch));
      return null;
    },

    async 'vcs.merge_abort'(params) {
      const git = requireGit(dependencies, params.session_id);
      git.mergeAbort();
      return null;
    },

    async 'vcs.merge_continue'(params) {
      const git = requireGit(dependencies, params.session_id);
      git.mergeContinue(asTrimmedString(params.message));
      return null;
    },

    async 'vcs.is_merge_in_progress'(params) {
      const git = requireGit(dependencies, params.session_id);
      return git.isMergeInProgress();
    },

    async 'vcs.set_branch_upstream'(params) {
      const git = requireGit(dependencies, params.session_id);
      git.setBranchUpstream(
        asTrimmedString(params.name),
        asTrimmedString(params.upstream),
      );
      return null;
    },

    async 'vcs.get_branch_upstream'(params) {
      const git = requireGit(dependencies, params.session_id);
      return git.getBranchUpstream(asTrimmedString(params.name));
    },

    async 'vcs.hard_reset_head'(params) {
      const git = requireGit(dependencies, params.session_id);
      git.hardResetHead(asTrimmedString(params.ref));
      return null;
    },

    async 'vcs.reset_soft_to'(params) {
      const git = requireGit(dependencies, params.session_id);
      git.resetSoftTo(asTrimmedString(params.ref));
      return null;
    },

    async 'vcs.get_identity'(params) {
      const git = requireGit(dependencies, params.session_id);
      return git.getIdentity();
    },

    async 'vcs.set_identity_local'(params) {
      const git = requireGit(dependencies, params.session_id);
      git.setIdentityLocal(
        asTrimmedString(params.name),
        asTrimmedString(params.email),
      );
      return null;
    },

    async 'vcs.list_stashes'(params) {
      const git = requireGit(dependencies, params.session_id);
      return git.listStashes();
    },

    async 'vcs.stash_push'(params) {
      const git = requireGit(dependencies, params.session_id);
      return git.stashPush(
        asTrimmedString(params.message),
        params.include_untracked,
      );
    },

    async 'vcs.stash_apply'(params) {
      const git = requireGit(dependencies, params.session_id);
      git.stashApply(asString(params.selector));
      return null;
    },

    async 'vcs.stash_pop'(params) {
      const git = requireGit(dependencies, params.session_id);
      git.stashPop(asString(params.selector));
      return null;
    },

    async 'vcs.stash_drop'(params) {
      const git = requireGit(dependencies, params.session_id);
      git.stashDrop(asString(params.selector));
      return null;
    },

    async 'vcs.stash_show'(params) {
      const git = requireGit(dependencies, params.session_id);
      return git.stashShow(asString(params.selector));
    },

    async 'vcs.cherry_pick'(params) {
      const git = requireGit(dependencies, params.session_id);
      git.cherryPick(asTrimmedString(params.commit));
      return null;
    },

    async 'vcs.revert_commit'(params) {
      const git = requireGit(dependencies, params.session_id);
      git.revertCommit(asTrimmedString(params.commit), params.no_edit);
      return null;
    },
  };
}
