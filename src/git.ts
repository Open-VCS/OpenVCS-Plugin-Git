// Copyright © 2025-2026 OpenVCS Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { pluginError } from '@openvcs/sdk/runtime';
import type {
  CommitEntry,
  StatusParseResult,
} from '@openvcs/sdk/types';
import type { GitCommandResult, RunGitOptions } from './plugin-types.js';
import {
  applySubmoduleStatusHints,
  asString,
  buildFetchArgs,
  buildPullArgs,
  buildPushArgs,
  buildSubmoduleUpdateArgs,
  parseCommits,
  parseStatusOutput,
} from './plugin-helpers.js';

export interface FetchOptions {
  remote?: string;
  refspec?: string;
  opts?: { prune?: boolean };
}

export interface PushOptions {
  remote?: string;
  refspec?: string;
}

export interface PullOptions {
  remote?: string;
  branch?: string;
}

export interface ListCommitsOptions {
  branch?: string;
  skip?: number;
  limit?: number;
  topo_order?: boolean;
  include_merges?: boolean;
  author_contains?: string;
  since_utc?: string;
  until_utc?: string;
  path?: string;
}

export interface BranchParseResult {
  current: string | null;
  branches: Array<{ name: string; current: boolean }>;
}

export interface RemoteParseResult {
  remotes: Array<{ name: string; fetch: string; push: string }>;
}

export interface ConflictDetails {
  path: string;
  ours: string | null;
  theirs: string | null;
  base: string | null;
  binary: boolean;
  lfs_pointer: boolean;
}

export interface StashEntry {
  selector: string;
  msg: string;
  meta: string;
}

export interface SubmoduleEntry {
  path: string;
  name: string;
  url?: string;
  branch?: string;
  commit?: string;
  state: 'clean' | 'dirty' | 'uninitialized' | 'conflicted';
}

export class GitCommand {
  private readonly cwd: string;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  run(args: string[], options: RunGitOptions = {}): GitCommandResult {
    const result = spawnSync('git', args, {
      cwd: this.cwd,
      input: typeof options.stdin === 'string' ? options.stdin : undefined,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });

    /* c8 ignore next 9 */
    if (result.status === null) {
      const signal = result.signal ?? 'unknown';
      console.warn(`git process killed/crashed (signal: ${signal}) in ${this.cwd}: ${args.join(' ')}`);
      return {
        status: -2,
        stdout: asString(result.stdout),
        stderr: asString(result.stderr) || `Process terminated by signal: ${signal}`,
      };
    }

    return {
      status: result.status,
      stdout: asString(result.stdout),
      stderr: asString(result.stderr),
    };
  }

  runChecked(args: string[], errorCode: string, options: RunGitOptions = {}): GitCommandResult {
    const output = this.run(args, options);

    if (output.status !== 0) {
      const exitInfo = output.status === -2 ? ` (signal: ${output.stderr})` : ` (exit code: ${output.status})`;
      const message =
        output.stderr.trim() ||
        output.stdout.trim() ||
        `git ${args.join(' ')}${exitInfo}`;
      throw pluginError(errorCode, message);
    }

    return output;
  }

  version(): { result: GitCommandResult; version: string; major: number; minor: number } {
    const result = this.run(['--version']);
    const versionMatch = result.stdout.match(/git version (\d+)\.(\d+)/);
    if (!versionMatch) {
      throw new Error(`Unable to parse Git version: ${result.stdout.trim()}`);
    }
    const major = parseInt(versionMatch[1], 10);
    const minor = parseInt(versionMatch[2], 10);
    return {
      result,
      version: versionMatch[0],
      major,
      minor,
    };
  }

  status(): StatusParseResult & { exitCode: number } {
    const result = this.run(['status', '--porcelain=1', '--branch', '-z', '-uall']);
    const parsed = applySubmoduleStatusHints(parseStatusOutput(result.stdout), this.listSubmodulePaths());
    return { ...parsed, exitCode: result.status };
  }

  currentBranch(): string {
    const result = this.runChecked(['rev-parse', '--abbrev-ref', 'HEAD'], 'git-branch-failed');
    return result.stdout.trim();
  }

  listBranches(): BranchParseResult {
    const result = this.run(['branch', '-a', '--format=%(refname:short)%(if)%(HEAD)%(then)*%(end)']);
    const current = this.currentBranch();
    const branches: Array<{ name: string; current: boolean }> = [];

    for (const line of result.stdout.split('\n').filter(Boolean)) {
      const isCurrent = line.endsWith('*');
      const baseLine = isCurrent ? line.slice(0, -1) : line;
      const name = baseLine.trim();
      if (name) {
        branches.push({ name, current: name === current || (isCurrent && name === current) });
      }
    }

    return { current, branches };
  }

  listLocalBranches(): BranchParseResult {
    const result = this.run(['branch', '--format=%(refname:short)%(if)%(HEAD)%(then)*%(end)']);
    const current = this.currentBranch();
    const branches: Array<{ name: string; current: boolean }> = [];

    for (const line of result.stdout.split('\n').filter(Boolean)) {
      const trimmed = line.replaceAll('*', '').trim();
      if (trimmed) {
        branches.push({ name: trimmed, current: trimmed === current });
      }
    }

    return { current, branches };
  }

  createBranch(name: string): void {
    this.runChecked(['branch', name], 'git-branch-create-failed');
  }

  checkoutBranch(name: string): void {
    this.runChecked(['checkout', name], 'git-checkout-failed');
  }

  deleteBranch(name: string): void {
    this.runChecked(['branch', '-d', name], 'git-branch-delete-failed');
  }

  renameBranch(oldName: string, newName: string): void {
    this.runChecked(['branch', '-m', oldName, newName], 'git-branch-rename-failed');
  }

  getBranchUpstream(branchName: string): string | null {
    const result = this.run(['rev-parse', '--abbrev-ref', `${branchName}@{upstream}`]);
    return result.status === 0 ? result.stdout.trim() : null;
  }

  setBranchUpstream(branchName: string, upstream: string): void {
    this.runChecked(['branch', '--set-upstream-to', upstream, branchName], 'git-branch-upstream-failed');
  }

  ensureRemote(name: string, url: string): void {
    const probe = this.run(['remote', 'get-url', name]);
    if (probe.status === 0) {
      if (probe.stdout.trim() !== url) {
        this.runChecked(['remote', 'set-url', name, url], 'git-remote-set-url-failed');
      }
    } else {
      this.runChecked(['remote', 'add', name, url], 'git-remote-add-failed');
    }
  }

  listRemotes(): RemoteParseResult {
    const result = this.runChecked(['remote', '-v'], 'git-remote-list-failed');
    const remotes: Array<{ name: string; fetch: string; push: string }> = [];
    const remoteMap = new Map<string, { fetch: string; push: string }>();

    for (const line of result.stdout.split('\n').filter(Boolean)) {
      const match = line.match(/^(\S+)\s+(\S+)\s+\((\w+)\)$/);
      if (match) {
        const [, name, url, type] = match;
        if (!remoteMap.has(name)) {
          remoteMap.set(name, { fetch: '', push: '' });
        }
        const entry = remoteMap.get(name)!;
        if (type === 'fetch') {
          entry.fetch = url;
        } else if (type === 'push') {
          entry.push = url;
        }
      }
    }

    remoteMap.forEach((value, key) => {
      remotes.push({ name: key, ...value });
    });

    return { remotes };
  }

  removeRemote(name: string): void {
    this.runChecked(['remote', 'remove', name], 'git-remote-remove-failed');
  }

  fetch(options: FetchOptions = {}): GitCommandResult {
    const args = buildFetchArgs(options as unknown as Record<string, unknown>);
    return this.runChecked(args, 'git-fetch-failed');
  }

  push(options: PushOptions = {}): GitCommandResult {
    const args = buildPushArgs(options as unknown as Record<string, unknown>);
    return this.runChecked(args, 'git-push-failed');
  }

  pull(options: PullOptions = {}): GitCommandResult {
    const args = buildPullArgs(options as unknown as Record<string, unknown>);
    return this.runChecked(args, 'git-pull-failed');
  }

  /** Returns the current HEAD commit id. */
  currentHead(): string {
    return this.runChecked(['rev-parse', 'HEAD'], 'git-head-failed').stdout.trim();
  }

  /** Creates a commit, optionally limited to the provided paths. */
  commit(message: string, name?: string, email?: string, paths?: string[]): GitCommandResult {
    const execArgs = [
      ...(name ? ['-c', `user.name=${name}`] : []),
      ...(email ? ['-c', `user.email=${email}`] : []),
      'commit',
      '-m',
      message,
      ...(paths && paths.length > 0 ? ['--', ...paths] : []),
    ];

    return this.runChecked(execArgs, 'git-commit-failed');
  }

  /** Creates a commit from the current index only. */
  commitIndex(message?: string, name?: string, email?: string): GitCommandResult {
    const commitMessage = message || 'Stage changes';

    const execArgs = [
      ...(name ? ['-c', `user.name=${name}`] : []),
      ...(email ? ['-c', `user.email=${email}`] : []),
      'commit',
      '-m',
      commitMessage,
    ];

    return this.runChecked(execArgs, 'git-commit-failed');
  }

  /** Stages the provided repository-relative paths into the index. */
  stagePaths(paths: string[]): void {
    if (paths.length === 0) {
      return;
    }

    this.runChecked(['add', '-A', '--', ...paths], 'git-stage-paths-failed');
  }

  /**
   * Lists commits from Git with an optional cap.
   *
   * A non-positive limit skips the `-n` flag so callers can request the full
   * history without hard-capping the result set.
   */
  listCommits(options: ListCommitsOptions = {}): { commits: CommitEntry[]; exitCode: number } {
    const args = ['log'];

    if (options.topo_order) {
      args.push('--topo-order');
    }

    if (options.limit !== undefined && options.limit > 0) {
      args.push(`-${options.limit}`);
    }

    if (options.skip !== undefined) {
      args.push(`--skip=${options.skip}`);
    }

    if (options.include_merges === false) {
      args.push('--no-merges');
    }

    if (options.author_contains) {
      args.push(`--author=${options.author_contains}`);
    }

    if (options.since_utc) {
      args.push(`--since=${options.since_utc}`);
    }

    if (options.until_utc) {
      args.push(`--until=${options.until_utc}`);
    }

    args.push('--pretty=format:%H%x00%s%x00%aN%x00%aI%x00%P%x1e');

    if (options.branch) {
      args.push(options.branch);
    }

    if (options.path) {
      args.push('--', options.path);
    }

    const result = this.runChecked(args, 'git-log-failed');
    const commits = parseCommits(result.stdout);
    return { commits, exitCode: 0 };
  }

  /** Reads `.gitmodules` entries indexed by submodule name and path. */
  private readSubmoduleConfig(): {
    byName: Map<string, { name: string; path?: string; url?: string; branch?: string }>;
    byPath: Map<string, { name: string; url?: string; branch?: string }>;
  } {
    const configResult = this.run(['config', '-f', '.gitmodules', '--null', '--list']);
    const byName = new Map<string, { name: string; path?: string; url?: string; branch?: string }>();

    if (configResult.status === 0) {
      for (const entry of configResult.stdout.split('\0')) {
        const trimmed = entry.trim();
        if (!trimmed) continue;

        const splitAt = trimmed.indexOf('\n');
        if (splitAt < 0) continue;

        const key = trimmed.slice(0, splitAt).trim();
        const value = trimmed.slice(splitAt + 1);
        const match = key.match(/^submodule\.(.+)\.(path|url|branch)$/);
        if (!match) continue;

        const [, name, field] = match;
        const target = byName.get(name) || { name };

        if (field === 'path') target.path = value;
        if (field === 'url') target.url = value;
        if (field === 'branch') target.branch = value;

        byName.set(name, target);
      }
    }

    const byPath = new Map<string, { name: string; url?: string; branch?: string }>();
    for (const entry of byName.values()) {
      if (entry.path) {
        byPath.set(entry.path, entry);
      }
    }

    return { byName, byPath };
  }

  /** Returns known submodule paths from `.gitmodules`. */
  private listSubmodulePaths(): Set<string> {
    return new Set(this.readSubmoduleConfig().byPath.keys());
  }

  listSubmodules(): SubmoduleEntry[] {
    const { byPath: configByPath } = this.readSubmoduleConfig();

    const statusResult = this.run(['submodule', 'status', '--recursive']);
    if (statusResult.status !== 0) {
      return [];
    }

    const stateFor = (marker: string): SubmoduleEntry['state'] => {
      if (marker === '-') return 'uninitialized';
      if (marker === '+') return 'dirty';
      if (marker === 'U') return 'conflicted';
      return 'clean';
    };

    const entries: SubmoduleEntry[] = [];
    for (const rawLine of statusResult.stdout.split(/\r?\n/g)) {
      const line = rawLine.trim();
      if (!line) continue;

      const marker = line[0] || ' ';
      const rest = line.slice(1).trim();
      const [commit = '', path = ''] = rest.split(/\s+/);
      if (!path) continue;

      const config = configByPath.get(path);
      entries.push({
        path,
        name: config?.name || path.split('/').filter(Boolean).at(-1) || path,
        url: config?.url,
        branch: config?.branch,
        commit,
        state: stateFor(marker),
      });
    }

    return entries.sort((a, b) => a.path.localeCompare(b.path));
  }

  addSubmodule(url: string, path: string, name?: string, branch?: string): GitCommandResult {
    const args = ['submodule', 'add'];
    if (name) args.push('--name', name);
    if (branch) args.push('--branch', branch);
    args.push(url, path);
    return this.runChecked(args, 'git-submodule-add-failed');
  }

  updateSubmodule(path: string): GitCommandResult {
    return this.runChecked(buildSubmoduleUpdateArgs({ path }), 'git-submodule-update-failed');
  }

  updateAllSubmodules(): GitCommandResult {
    return this.runChecked(buildSubmoduleUpdateArgs({}), 'git-submodule-update-failed');
  }

  /** Updates one submodule from its configured branch recursively. */
  updateSubmoduleRemote(path: string): GitCommandResult {
    return this.runChecked(buildSubmoduleUpdateArgs({ path, remote: true }), 'git-submodule-update-remote-failed');
  }

  /** Updates all submodules from their configured branches recursively. */
  updateAllSubmodulesRemote(): GitCommandResult {
    return this.runChecked(buildSubmoduleUpdateArgs({ remote: true }), 'git-submodule-update-remote-failed');
  }

  syncSubmodule(path: string): GitCommandResult {
    return this.runChecked(['submodule', 'sync', '--recursive', '--', path], 'git-submodule-sync-failed');
  }

  syncAllSubmodules(): GitCommandResult {
    return this.runChecked(['submodule', 'sync', '--recursive'], 'git-submodule-sync-failed');
  }

  removeSubmodule(path: string): void {
    this.runChecked(['submodule', 'deinit', '-f', '--', path], 'git-submodule-remove-failed');
    this.runChecked(['rm', '-f', '--', path], 'git-submodule-remove-failed');

    const modulesPath = join(this.cwd, '.git', 'modules', path);
    /* c8 ignore next 4 */
    try {
      rmSync(modulesPath, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup.
    }
  }

  diffFile(path: string): string {
    const cachedDiff = this.runChecked(['diff', '--cached', '--no-ext-diff', '--', path], 'git-diff-failed')
      .stdout;
    const worktreeDiff = this.runChecked(['diff', '--no-ext-diff', '--', path], 'git-diff-failed')
      .stdout;
    return cachedDiff + worktreeDiff;
  }

  diffCommit(commit: string): string {
    const parentCheck = this.run(['rev-parse', '--verify', `${commit}^`]);
    if (parentCheck.status === 0) {
      return this.runChecked(['diff', `${commit}^`, commit], 'git-diff-failed').stdout;
    }

    return this.runChecked(
      ['diff-tree', '--root', '--no-commit-id', '--no-ext-diff', '-p', commit],
      'git-diff-failed',
    ).stdout;
  }

  getConflictDetails(path: string): ConflictDetails {
    const ours = this.run(['show', `:2:${path}`]);
    const theirs = this.run(['show', `:3:${path}`]);
    const base = this.run(['show', `:1:${path}`]);

    if (ours.status !== 0 || theirs.status !== 0) {
      return { path, ours: null, theirs: null, base: null, binary: false, lfs_pointer: false };
    }

    const oursContent = ours.stdout;
    const lfs_pointer =
      ours.stdout.includes('version https://git-lfs.github.com/spec/v1') ||
      theirs.stdout.includes('version https://git-lfs.github.com/spec/v1');

    const binary = !lfs_pointer && (oursContent.startsWith('Binary\0') || oursContent.includes('\0'));

    return {
      path,
      ours: ours.stdout,
      theirs: theirs.stdout,
      base: base.status === 0 ? base.stdout : null,
      binary,
      lfs_pointer,
    };
  }

  checkoutConflictSide(path: string, side: 'ours' | 'theirs'): void {
    const ref = side === 'ours' ? ':2' : ':3';
    this.runChecked(['checkout', ref, '--', path], 'git-checkout-conflict-failed');
  }

  writeMergeResult(path: string, content: string): void {
    const args = ['update-index', '--add', '--cacheinfo', '100644', this.hashObject(content), path];
    this.runChecked(args, 'git-write-merge-result-failed');
  }

  private hashObject(content: string): string {
    return this.run(['hash-object', '-w', '--stdin'], { stdin: content }).stdout.trim();
  }

  /** Stages a textual patch into the index without requiring worktree/index parity. */
  stagePatch(patch: string): void {
    const lines = patch.split('\n');
    const retained: Array<{ path: string; text: string[] }> = [];
    let current: string[] = [];
    let currentPath: string | null = null;
    let unparseable = false;

    const flush = (): void => {
      if (current.length === 0) {
        return;
      }

      if (!currentPath) {
        unparseable = true;
        return;
      }

      retained.push({ path: currentPath, text: current });
    };

    for (const line of lines) {
      if (line.startsWith('diff --git ')) {
        flush();
        current = [line];
        const marker = line.indexOf(' b/');
        currentPath = marker >= 0 ? line.slice(marker + 3) : null;
        continue;
      }

      if (current.length > 0) {
        current.push(line);
      }
    }

    flush();

    if (retained.length > 1 && !unparseable) {
      const seen = new Set<string>();
      const filtered: string[][] = [];

      for (let index = retained.length - 1; index >= 0; index -= 1) {
        const section = retained[index];
        if (seen.has(section.path)) {
          continue;
        }

        seen.add(section.path);
        filtered.push(section.text);
      }

      filtered.reverse();
      patch = filtered.map((section) => section.join('\n')).join('\n');
    }

    this.runChecked(['apply', '--cached', '--unidiff-zero'], 'git-stage-patch-failed', {
      stdin: patch,
    });
  }

  applyReversePatch(patch: string): void {
    this.runChecked(['apply', '-R', patch], 'git-apply-reverse-failed');
  }

  hardResetHead(ref?: string): void {
    this.runChecked(['reset', '--hard', ref ?? 'HEAD'], 'git-reset-hard-failed');
  }

  resetSoftTo(ref: string): void {
    this.runChecked(['reset', '--soft', ref], 'git-reset-soft-failed');
  }

  /** Reads the effective Git commit identity from config. */
  getIdentity(): { name: string; email: string } | null {
    const nameResult = this.run(['config', '--get', 'user.name']);
    const emailResult = this.run(['config', '--get', 'user.email']);

    if (nameResult.status !== 0 || emailResult.status !== 0) {
      return null;
    }

    return {
      name: nameResult.stdout.trim(),
      email: emailResult.stdout.trim(),
    };
  }

  /** Stores repository-local commit identity in Git config. */
  setIdentityLocal(name: string, email: string): void {
    this.runChecked(['config', '--local', 'user.name', name], 'git-identity-set-failed');
    this.runChecked(['config', '--local', 'user.email', email], 'git-identity-set-failed');
  }

  mergeIntoCurrent(branch: string): void {
    this.runChecked(['merge', branch], 'git-merge-failed');
  }

  mergeAbort(): void {
    this.runChecked(['merge', '--abort'], 'git-merge-abort-failed');
  }

  mergeContinue(message?: string): void {
    const args = ['commit'];
    if (message) {
      args.push('-m', message);
    }
    this.runChecked(args, 'git-merge-continue-failed');
  }

  isMergeInProgress(): boolean {
    const result = this.run(['rev-parse', '--verify', '-q', 'MERGE_HEAD']);
    return result.status === 0;
  }

  listStashes(): StashEntry[] {
    const result = this.runChecked(
      ['stash', 'list', '--pretty=format:%gd%x1f%s%x1e'],
      'git-stash-list-failed',
    );
    return result.stdout
      .split('\u001e')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [selector = '', msg = ''] = line.split('\u001f');
        return { selector, msg, meta: '' };
      });
  }

  stashPush(message?: string, includeUntracked?: boolean): string {
    const args = ['stash', 'push'];
    if (includeUntracked) {
      args.push('--include-untracked');
    }
    if (message) {
      args.push('-m', message);
    }
    this.runChecked(args, 'git-stash-push-failed');
    return this.runChecked(
      ['stash', 'list', '-n', '1', '--pretty=format:%gd'],
      'git-stash-push-failed',
    ).stdout.trim();
  }

  stashApply(selector: string): void {
    this.runChecked(['stash', 'apply', selector], 'git-stash-apply-failed');
  }

  stashPop(selector: string): void {
    this.runChecked(['stash', 'pop', selector], 'git-stash-pop-failed');
  }

  stashDrop(selector: string): void {
    this.runChecked(['stash', 'drop', selector], 'git-stash-drop-failed');
  }

  stashShow(selector: string): string {
    return this.runChecked(['stash', 'show', '-p', selector], 'git-stash-show-failed').stdout;
  }

  cherryPick(commit: string): void {
    this.runChecked(['cherry-pick', commit], 'git-cherry-pick-failed');
  }

  revertCommit(commit: string, noEdit?: boolean): void {
    const args = ['revert'];
    if (noEdit) {
      args.push('--no-edit');
    }
    args.push(commit);
    this.runChecked(args, 'git-revert-failed');
  }
}
