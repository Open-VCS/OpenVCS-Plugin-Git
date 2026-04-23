// Copyright © 2025-2026 OpenVCS Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import {
  VcsDelegateBase,
  pluginError,
  type PluginRuntimeContext,
} from '@openvcs/sdk/runtime';
import type * as OpenVcs from '@openvcs/sdk/types';

import {
  asNumber,
  asRecord,
  asString,
  asStringArray,
  asTrimmedString,
  buildCloneArgs,
  parseStatusOutput,
} from './plugin-helpers.js';
import { GitCommand } from './git.js';
import type { GitSession } from './plugin-types.js';

/** Describes the Git operations needed to discard a set of paths safely. */
export interface DiscardPathPlan {
  /** Restores tracked paths from HEAD in both the index and worktree. */
  restore: string[];
  /** Removes newly added index entries before deleting their worktree files. */
  unstageThenRemove: string[];
  /** Deletes untracked worktree paths after index state has been corrected. */
  clean: string[];
}

/** Returns an optional boolean only when the input is already a boolean. */
function asOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/** Reduces a file status string to the primary status code needed for discard routing. */
function getPrimaryDiscardStatus(status: string): string {
  const normalized = asTrimmedString(status);
  if (!normalized) {
    return 'M';
  }

  for (const candidate of ['?', 'R', 'C', 'A', 'D', 'U', 'T', 'S', 'M']) {
    if (normalized.includes(candidate)) {
      return candidate;
    }
  }

  return normalized[0] ?? 'M';
}

/** Builds a discard plan that handles tracked, added, copied, and renamed paths. */
export function planDiscardPaths(statusOutput: string): DiscardPathPlan {
  const restore = new Set<string>();
  const unstageThenRemove = new Set<string>();
  const clean = new Set<string>();
  const parsed = parseStatusOutput(statusOutput);

  for (const file of parsed.payload.files) {
    const path = asTrimmedString(file.path);
    const oldPath = asTrimmedString(file.old_path);
    const primaryStatus = getPrimaryDiscardStatus(file.status);

    if (!path) {
      continue;
    }

    if (primaryStatus === '?') {
      clean.add(path);
      continue;
    }

    if (primaryStatus === 'R') {
      if (oldPath) {
        restore.add(oldPath);
      }
      if (file.staged) {
        unstageThenRemove.add(path);
      }
      clean.add(path);
      continue;
    }

    if (primaryStatus === 'C' || primaryStatus === 'A') {
      if (file.staged) {
        unstageThenRemove.add(path);
      }
      clean.add(path);
      continue;
    }

    restore.add(path);
  }

  return {
    restore: Array.from(restore),
    unstageThenRemove: Array.from(unstageThenRemove),
    clean: Array.from(clean),
  };
}

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

/** Implements the Git-backed `vcs.*` delegate surface for the SDK runtime. */
export class GitVcsDelegates extends VcsDelegateBase<GitRuntimeDependencies> {
  /** Returns the required repository worktree path for a session id. */
  protected requireSessionPath(sessionId: unknown): string {
    return this.deps.requireSession(sessionId).path;
  }

  /** Returns a Git command helper bound to a required session. */
  protected requireGit(sessionId: unknown): GitCommand {
    const cwd = this.requireSessionPath(sessionId);
    return this.deps.createGitCommand(cwd);
  }

  override getCaps(
    _params: OpenVcs.RequestParams,
    _context: PluginRuntimeContext,
  ): OpenVcs.VcsCapabilities {
    return {
      commits: true,
      branches: true,
      tags: true,
      staging: true,
      push_pull: true,
      fast_forward: true,
    };
  }

  override open(
    params: OpenVcs.VcsOpenParams,
    _context: PluginRuntimeContext,
  ): OpenVcs.VcsSessionResult {
    const repoPath = asTrimmedString(params.path);
    if (!repoPath) {
      throw pluginError('vcs-open-invalid-path', 'path is required');
    }

    const git = this.deps.createGitCommand(repoPath);
    git.runChecked(['rev-parse', '--git-dir'], 'vcs-open-not-repository');
    const sessionId = this.deps.allocateSession({ path: repoPath });
    return { session_id: sessionId };
  }

  override close(
    params: OpenVcs.VcsSessionParams,
    _context: PluginRuntimeContext,
  ): null {
    this.deps.closeSession(params.session_id);
    return null;
  }

  override cloneRepo(
    params: OpenVcs.VcsCloneRepoParams,
    context: PluginRuntimeContext,
  ): null {
    const url = asTrimmedString(params.url);
    const destination = asTrimmedString(params.dest);

    if (!url || !destination) {
      throw pluginError('vcs-clone-invalid-args', 'url and dest are required');
    }

    const git = this.deps.createGitCommand(process.cwd());
    const output = git.runChecked(buildCloneArgs({ url, dest: destination }), 'vcs-clone-failed');
    const lines = `${output.stdout}\n${output.stderr}`
      .split(/\r?\n/g)
      .map((line) => line.trim())
      .filter(Boolean);

    for (const line of lines) {
      context.host.info(line);
    }

    return null;
  }

  override getWorkdir(
    params: OpenVcs.VcsSessionParams,
    _context: PluginRuntimeContext,
  ): string {
    return this.requireSessionPath(params.session_id);
  }

  override getCurrentBranch(
    params: OpenVcs.VcsSessionParams,
    _context: PluginRuntimeContext,
  ): string | null {
    const git = this.requireGit(params.session_id);
    const branch = git.currentBranch();
    return branch === 'HEAD' ? null : branch;
  }

  override listBranches(
    params: OpenVcs.VcsSessionParams,
    _context: PluginRuntimeContext,
  ): OpenVcs.VcsBranchEntry[] {
    const git = this.requireGit(params.session_id);
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
      .map((line): OpenVcs.VcsBranchEntry => {
        const [name = '', fullRef = '', headMark = ''] = line.split('\t');
        const isRemote = fullRef.startsWith('refs/remotes/');
        const remote = isRemote ? name.split('/')[0] ?? null : null;
        const kind: OpenVcs.VcsBranchKind = isRemote
          ? { type: 'Remote', remote }
          : { type: 'Local' };

        return {
          name,
          full_ref: fullRef,
          kind,
          current: headMark === '*',
        };
      });
  }

  override listLocalBranches(
    params: OpenVcs.VcsSessionParams,
    _context: PluginRuntimeContext,
  ): string[] {
    const git = this.requireGit(params.session_id);
    const raw = git.runChecked(
      ['for-each-ref', '--format=%(refname:short)', 'refs/heads/'],
      'vcs-list-branches-failed',
    );

    return raw.stdout
      .split('\n')
      .map((branch) => branch.trim())
      .filter(Boolean);
  }

  override createBranch(
    params: OpenVcs.VcsCreateBranchParams,
    _context: PluginRuntimeContext,
  ): null {
    const git = this.requireGit(params.session_id);
    git.createBranch(asTrimmedString(params.name));
    return null;
  }

  override checkoutBranch(
    params: OpenVcs.VcsCheckoutBranchParams,
    _context: PluginRuntimeContext,
  ): null {
    const git = this.requireGit(params.session_id);
    git.checkoutBranch(asTrimmedString(params.name));
    return null;
  }

  override ensureRemote(
    params: OpenVcs.VcsEnsureRemoteParams,
    _context: PluginRuntimeContext,
  ): null {
    const git = this.requireGit(params.session_id);
    const name = asTrimmedString(params.name);
    const url = asTrimmedString(params.url);
    if (!name || !url) {
      throw pluginError('vcs-remote-invalid-args', 'name and url are required');
    }

    git.ensureRemote(name, url);
    return null;
  }

  override listRemotes(
    params: OpenVcs.VcsSessionParams,
    _context: PluginRuntimeContext,
  ): OpenVcs.VcsRemoteEntry[] {
    const git = this.requireGit(params.session_id);
    const result = git.listRemotes();
    return result.remotes.map((remote) => ({
      name: remote.name,
      url: remote.fetch || remote.push,
    }));
  }

  override removeRemote(
    params: OpenVcs.VcsRemoveRemoteParams,
    _context: PluginRuntimeContext,
  ): null {
    const git = this.requireGit(params.session_id);
    git.removeRemote(asTrimmedString(params.name));
    return null;
  }

  override fetch(
    params: OpenVcs.VcsFetchParams,
    _context: PluginRuntimeContext,
  ): null {
    const git = this.requireGit(params.session_id);
    const options = asRecord(params.opts);
    git.fetch({
      remote: asTrimmedString(params.remote) || undefined,
      refspec: asTrimmedString(params.refspec) || undefined,
      opts: { prune: options.prune === true },
    });
    return null;
  }

  override push(
    params: OpenVcs.VcsPushParams,
    _context: PluginRuntimeContext,
  ): null {
    const git = this.requireGit(params.session_id);
    git.push({
      remote: asTrimmedString(params.remote) || undefined,
      refspec: asTrimmedString(params.refspec) || undefined,
    });
    return null;
  }

  override pullFfOnly(
    params: OpenVcs.VcsPullFfOnlyParams,
    _context: PluginRuntimeContext,
  ): null {
    const git = this.requireGit(params.session_id);
    git.pull({
      remote: asTrimmedString(params.remote) || undefined,
      branch: asTrimmedString(params.branch) || undefined,
    });
    return null;
  }

  override commit(
    params: OpenVcs.VcsCommitParams,
    _context: PluginRuntimeContext,
  ): string {
    const git = this.requireGit(params.session_id);
    git.commit(
      asTrimmedString(params.message),
      asTrimmedString(params.name),
      asTrimmedString(params.email),
      asStringArray(params.paths),
    );
    return git.currentHead();
  }

  override commitIndex(
    params: OpenVcs.VcsCommitParams,
    _context: PluginRuntimeContext,
  ): string {
    const git = this.requireGit(params.session_id);
    git.commitIndex(
      asTrimmedString(params.message),
      asTrimmedString(params.name),
      asTrimmedString(params.email),
    );
    return git.currentHead();
  }

  override getStatusSummary(
    params: OpenVcs.VcsSessionParams,
    _context: PluginRuntimeContext,
  ): OpenVcs.StatusSummary {
    const git = this.requireGit(params.session_id);
    return git.status().summary;
  }

  override getStatusPayload(
    params: OpenVcs.VcsSessionParams,
    _context: PluginRuntimeContext,
  ): OpenVcs.StatusPayload {
    const git = this.requireGit(params.session_id);
    return git.status().payload;
  }

  override listCommits(
    params: OpenVcs.VcsListCommitsParams,
    _context: PluginRuntimeContext,
  ): OpenVcs.CommitEntry[] {
    const git = this.requireGit(params.session_id);
    const query = asRecord(params.query);
    const result = git.listCommits({
      branch: asTrimmedString(query.rev) || undefined,
      skip: asNumber(query.skip, 0) || undefined,
      limit: asNumber(query.limit, 0),
      topo_order: asOptionalBoolean(query.topo_order),
      include_merges: asOptionalBoolean(query.include_merges),
      author_contains: asTrimmedString(query.author_contains) || undefined,
      since_utc: asTrimmedString(query.since_utc) || undefined,
      until_utc: asTrimmedString(query.until_utc) || undefined,
      path: asTrimmedString(query.path) || undefined,
    });
    return result.commits;
  }

  override diffFile(
    params: OpenVcs.VcsDiffFileParams,
    _context: PluginRuntimeContext,
  ): string[] {
    const git = this.requireGit(params.session_id);
    return git.diffFile(asTrimmedString(params.path)).split('\n');
  }

  override diffCommit(
    params: OpenVcs.VcsDiffCommitParams,
    _context: PluginRuntimeContext,
  ): string[] {
    const git = this.requireGit(params.session_id);
    return git.diffCommit(asTrimmedString(params.rev)).split('\n');
  }

  override getConflictDetails(
    params: OpenVcs.VcsGetConflictDetailsParams,
    _context: PluginRuntimeContext,
  ): OpenVcs.VcsConflictDetails {
    const git = this.requireGit(params.session_id);
    return git.getConflictDetails(asTrimmedString(params.path));
  }

  override checkoutConflictSide(
    params: OpenVcs.VcsCheckoutConflictSideParams,
    _context: PluginRuntimeContext,
  ): null {
    const git = this.requireGit(params.session_id);
    const side = asTrimmedString(params.side);
    if (side !== 'ours' && side !== 'theirs') {
      throw pluginError('vcs-invalid-side', 'side must be "ours" or "theirs"');
    }

    git.checkoutConflictSide(asTrimmedString(params.path), side);
    return null;
  }

  override writeMergeResult(
    params: OpenVcs.VcsWriteMergeResultParams,
    _context: PluginRuntimeContext,
  ): null {
    const git = this.requireGit(params.session_id);
    const content = Buffer.from(asTrimmedString(params.content_b64), 'base64').toString(
      'utf8',
    );
    git.writeMergeResult(asTrimmedString(params.path), content);
    return null;
  }

  override stagePatch(
    params: OpenVcs.VcsStagePatchParams,
    _context: PluginRuntimeContext,
  ): null {
    const git = this.requireGit(params.session_id);
    git.stagePatch(asString(params.patch));
    return null;
  }

  override stagePaths(
    params: OpenVcs.VcsStagePathsParams,
    _context: PluginRuntimeContext,
  ): null {
    const git = this.requireGit(params.session_id);
    git.stagePaths(asStringArray(params.paths));
    return null;
  }

  override discardPaths(
    params: OpenVcs.VcsDiscardPathsParams,
    _context: PluginRuntimeContext,
  ): null {
    const git = this.requireGit(params.session_id);
    const paths = asStringArray(params.paths);
    if (paths.length === 0) {
      return null;
    }

    const status = git.runChecked(
      ['status', '--porcelain=1', '-z', '-uall', '--', ...paths],
      'git-discard-paths-failed',
    );
    const discardPlan = planDiscardPaths(status.stdout);

    let failure: unknown;

    if (discardPlan.unstageThenRemove.length > 0) {
      try {
        git.runChecked(
          ['rm', '-f', '--cached', '--', ...discardPlan.unstageThenRemove],
          'git-discard-paths-failed',
        );
      } catch (error) {
        failure = error;
      }
    }

    if (!failure && discardPlan.restore.length > 0) {
      try {
        git.runChecked(
          ['restore', '--source=HEAD', '--staged', '--worktree', '--', ...discardPlan.restore],
          'git-discard-paths-failed',
        );
      } catch (error) {
        failure = error;
      }
    }

    if (!failure && discardPlan.clean.length > 0) {
      git.runChecked(['clean', '-f', '--', ...discardPlan.clean], 'git-discard-paths-failed');
    }

    if (failure) {
      throw failure;
    }

    return null;
  }

  override applyReversePatch(
    params: OpenVcs.VcsApplyReversePatchParams,
    _context: PluginRuntimeContext,
  ): null {
    const git = this.requireGit(params.session_id);
    git.applyReversePatch(asString(params.patch));
    return null;
  }

  override deleteBranch(
    params: OpenVcs.VcsDeleteBranchParams,
    _context: PluginRuntimeContext,
  ): null {
    const git = this.requireGit(params.session_id);
    git.deleteBranch(asTrimmedString(params.name));
    return null;
  }

  override renameBranch(
    params: OpenVcs.VcsRenameBranchParams,
    _context: PluginRuntimeContext,
  ): null {
    const git = this.requireGit(params.session_id);
    git.renameBranch(asTrimmedString(params.old), asTrimmedString(params.new));
    return null;
  }

  override mergeIntoCurrent(
    params: OpenVcs.VcsMergeIntoCurrentParams,
    _context: PluginRuntimeContext,
  ): null {
    const git = this.requireGit(params.session_id);
    git.mergeIntoCurrent(asTrimmedString(params.name));
    return null;
  }

  override mergeAbort(
    params: OpenVcs.VcsSessionParams,
    _context: PluginRuntimeContext,
  ): null {
    const git = this.requireGit(params.session_id);
    git.mergeAbort();
    return null;
  }

  override mergeContinue(
    params: OpenVcs.VcsMergeContinueParams,
    _context: PluginRuntimeContext,
  ): null {
    const git = this.requireGit(params.session_id);
    git.mergeContinue(asTrimmedString(params.message) || undefined);
    return null;
  }

  override isMergeInProgress(
    params: OpenVcs.VcsSessionParams,
    _context: PluginRuntimeContext,
  ): boolean {
    const git = this.requireGit(params.session_id);
    return git.isMergeInProgress();
  }

  override setBranchUpstream(
    params: OpenVcs.VcsSetBranchUpstreamParams,
    _context: PluginRuntimeContext,
  ): null {
    const git = this.requireGit(params.session_id);
    git.setBranchUpstream(
      asTrimmedString(params.branch),
      asTrimmedString(params.upstream),
    );
    return null;
  }

  override getBranchUpstream(
    params: OpenVcs.VcsGetBranchUpstreamParams,
    _context: PluginRuntimeContext,
  ): string | null {
    const git = this.requireGit(params.session_id);
    return git.getBranchUpstream(asTrimmedString(params.branch));
  }

  override hardResetHead(
    params: OpenVcs.VcsHardResetHeadParams,
    _context: PluginRuntimeContext,
  ): null {
    const git = this.requireGit(params.session_id);
    git.hardResetHead(params.ref);
    return null;
  }

  override resetSoftTo(
    params: OpenVcs.VcsResetSoftToParams,
    _context: PluginRuntimeContext,
  ): null {
    const git = this.requireGit(params.session_id);
    git.resetSoftTo(asTrimmedString(params.rev));
    return null;
  }

  override getIdentity(
    params: OpenVcs.VcsSessionParams,
    _context: PluginRuntimeContext,
  ): OpenVcs.VcsIdentity | null {
    const git = this.requireGit(params.session_id);
    return git.getIdentity();
  }

  override setIdentityLocal(
    params: OpenVcs.VcsSetIdentityLocalParams,
    _context: PluginRuntimeContext,
  ): null {
    const git = this.requireGit(params.session_id);
    git.setIdentityLocal(
      asTrimmedString(params.name),
      asTrimmedString(params.email),
    );
    return null;
  }

  override listStashes(
    params: OpenVcs.VcsSessionParams,
    _context: PluginRuntimeContext,
  ): OpenVcs.StashEntry[] {
    const git = this.requireGit(params.session_id);
    return git.listStashes();
  }

  override stashPush(
    params: OpenVcs.VcsStashPushParams,
    _context: PluginRuntimeContext,
  ): string {
    const git = this.requireGit(params.session_id);
    return git.stashPush(
      asTrimmedString(params.message) || undefined,
      params.include_untracked,
    );
  }

  override stashApply(
    params: OpenVcs.VcsStashSelectorParams,
    _context: PluginRuntimeContext,
  ): null {
    const git = this.requireGit(params.session_id);
    git.stashApply(asString(params.selector));
    return null;
  }

  override stashPop(
    params: OpenVcs.VcsStashSelectorParams,
    _context: PluginRuntimeContext,
  ): null {
    const git = this.requireGit(params.session_id);
    git.stashPop(asString(params.selector));
    return null;
  }

  override stashDrop(
    params: OpenVcs.VcsStashSelectorParams,
    _context: PluginRuntimeContext,
  ): null {
    const git = this.requireGit(params.session_id);
    git.stashDrop(asString(params.selector));
    return null;
  }

  override stashShow(
    params: OpenVcs.VcsStashSelectorParams,
    _context: PluginRuntimeContext,
  ): string {
    const git = this.requireGit(params.session_id);
    return git.stashShow(asString(params.selector));
  }

  override cherryPick(
    params: OpenVcs.VcsCherryPickParams,
    _context: PluginRuntimeContext,
  ): null {
    const git = this.requireGit(params.session_id);
    git.cherryPick(asTrimmedString(params.commit));
    return null;
  }

  override revertCommit(
    params: OpenVcs.VcsRevertCommitParams,
    _context: PluginRuntimeContext,
  ): null {
    const git = this.requireGit(params.session_id);
    git.revertCommit(asTrimmedString(params.commit), params.no_edit);
    return null;
  }
}
