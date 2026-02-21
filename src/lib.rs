// Copyright © 2025-2026 OpenVCS Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

//! OpenVCS Git backend plugin.
//!
//! This plugin implements the `vcs` world using System Git through the host
//! `process-exec` API.

mod parse;

use parse::{parse_branches, parse_commits, parse_stashes, parse_status_payload};
use serde::Deserialize;
use std::sync::{Mutex, OnceLock};

use openvcs_core::bindings_vcs::exports::openvcs::plugin::plugin_api;
use openvcs_core::bindings_vcs::exports::openvcs::plugin::vcs_api;
use openvcs_core::bindings_vcs::openvcs::plugin::host_api;

/// Hook handling policy from host config.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
enum HookPolicy {
    /// Always allow hooks.
    Allow,
    /// Ask policy from host config; plugin treats this as allow.
    #[default]
    Ask,
    /// Deny hooks and use `--no-verify` for supported commands.
    Deny,
}

/// Effective Git settings consumed by this plugin.
#[derive(Debug, Clone)]
struct GitSettings {
    /// Whether fetch should include `--prune` by default.
    prune_on_fetch: bool,
    /// Hook policy for operations that can skip hooks.
    allow_hooks: HookPolicy,
}

impl Default for GitSettings {
    /// Returns default plugin settings aligned with host defaults.
    fn default() -> Self {
        Self {
            prune_on_fetch: true,
            allow_hooks: HookPolicy::Ask,
        }
    }
}

/// Mutable plugin runtime state.
#[derive(Debug, Clone, Default)]
struct PluginState {
    /// Repository workdir path used for commands.
    workdir: Option<String>,
    /// Last parsed host settings payload.
    settings: GitSettings,
}

/// Top-level config payload provided by the host in `open`.
#[derive(Debug, Deserialize, Default)]
struct HostOpenConfig {
    /// Git section from host config.
    #[serde(default)]
    git: HostGitConfig,
}

/// Git config subsection used by this plugin.
#[derive(Debug, Deserialize, Default)]
struct HostGitConfig {
    /// Selected backend id from host settings.
    #[serde(default)]
    backend: Option<String>,
    /// Fetch prune setting from host settings.
    #[serde(default)]
    prune_on_fetch: Option<bool>,
    /// Hook policy from host settings.
    #[serde(default)]
    allow_hooks: Option<String>,
}

/// Shared plugin state singleton.
static STATE: OnceLock<Mutex<PluginState>> = OnceLock::new();

/// Returns the process-wide plugin state mutex.
fn state_store() -> &'static Mutex<PluginState> {
    STATE.get_or_init(|| Mutex::new(PluginState::default()))
}

/// Result alias for VCS API operations.
type VcsResult<T> = Result<T, vcs_api::PluginError>;

/// Converts code/message into a VCS plugin error.
fn vcs_error(code: &str, message: impl Into<String>) -> vcs_api::PluginError {
    vcs_api::PluginError {
        code: code.to_string(),
        message: message.into(),
    }
}

/// Converts code/message into a lifecycle plugin error.
fn lifecycle_error(code: &str, message: impl Into<String>) -> plugin_api::PluginError {
    plugin_api::PluginError {
        code: code.to_string(),
        message: message.into(),
    }
}

/// Converts host API errors to VCS plugin errors.
fn host_to_vcs_error(err: host_api::HostError) -> vcs_api::PluginError {
    vcs_error(&err.code, err.message)
}

/// Returns a copy of current plugin state.
fn snapshot_state() -> PluginState {
    state_store()
        .lock()
        .expect("plugin state mutex poisoned")
        .clone()
}

/// Updates the repository workdir in plugin state.
fn set_workdir(path: &str) {
    if let Ok(mut state) = state_store().lock() {
        state.workdir = Some(path.to_string());
    }
}

/// Updates settings in plugin state.
fn set_settings(settings: GitSettings) {
    if let Ok(mut state) = state_store().lock() {
        state.settings = settings;
    }
}

/// Resolves required workdir from plugin state.
fn require_workdir() -> VcsResult<String> {
    let state = snapshot_state();
    state
        .workdir
        .ok_or_else(|| vcs_error("git.not-open", "repository is not open"))
}

/// Parses host config bytes into plugin settings.
fn settings_from_config(config: &[u8]) -> GitSettings {
    let mut settings = GitSettings::default();
    let parsed = serde_json::from_slice::<HostOpenConfig>(config).unwrap_or_default();

    if let Some(value) = parsed.git.prune_on_fetch {
        settings.prune_on_fetch = value;
    }

    settings.allow_hooks = match parsed.git.allow_hooks.as_deref().map(str::trim) {
        Some("allow") => HookPolicy::Allow,
        Some("deny") => HookPolicy::Deny,
        _ => HookPolicy::Ask,
    };

    // The host may still provide an older backend selector. This plugin is
    // System Git-only and intentionally ignores non-system selections.
    let _ = parsed.git.backend;

    settings
}

/// Builds default environment variables for Git child process execution.
fn git_env() -> Vec<host_api::EnvVar> {
    vec![host_api::EnvVar {
        key: "GIT_TERMINAL_PROMPT".to_string(),
        value: "0".to_string(),
    }]
}

/// Executes a command through host `process-exec`.
fn run_process(
    cwd: Option<&str>,
    program: &str,
    args: &[String],
    stdin: Option<&str>,
) -> VcsResult<host_api::ProcessExecOutput> {
    host_api::process_exec(cwd, program, args, &git_env(), stdin).map_err(host_to_vcs_error)
}

/// Executes Git and allows non-zero exits.
fn run_git_allow_failure(
    cwd: Option<&str>,
    args: Vec<String>,
    stdin: Option<&str>,
) -> VcsResult<host_api::ProcessExecOutput> {
    run_process(cwd, "git", &args, stdin)
}

/// Executes Git and returns an error when command exits unsuccessfully.
fn run_git(cwd: Option<&str>, args: Vec<String>, stdin: Option<&str>) -> VcsResult<String> {
    let output = run_git_allow_failure(cwd, args.clone(), stdin)?;
    if !output.success {
        let head = output.stderr.lines().next().unwrap_or("git command failed");
        return Err(vcs_error(
            "git.exec-failed",
            format!("{} (exit {}): {}", args.join(" "), output.status, head),
        ));
    }
    Ok(output.stdout)
}

/// Executes Git in the currently opened repository.
fn run_git_in_repo(args: Vec<String>, stdin: Option<&str>) -> VcsResult<String> {
    let workdir = require_workdir()?;
    run_git(Some(workdir.as_str()), args, stdin)
}

/// Executes Git in repo and returns output even on non-zero exit.
fn run_git_in_repo_allow_failure(args: Vec<String>) -> VcsResult<host_api::ProcessExecOutput> {
    let workdir = require_workdir()?;
    run_git_allow_failure(Some(workdir.as_str()), args, None)
}

/// Splits command output into lines preserving order.
fn to_lines(text: &str) -> Vec<String> {
    text.lines().map(str::to_string).collect::<Vec<_>>()
}

/// Returns true when hooks should be skipped for this operation.
fn deny_hooks() -> bool {
    snapshot_state().settings.allow_hooks == HookPolicy::Deny
}

/// Returns status summary counts from a parsed payload.
fn summarize_status(payload: &vcs_api::StatusPayload) -> vcs_api::StatusSummary {
    let mut summary = vcs_api::StatusSummary {
        untracked: 0,
        modified: 0,
        staged: 0,
        conflicted: 0,
    };

    for file in &payload.files {
        if file.status == "?" {
            summary.untracked += 1;
            continue;
        }
        if file.status == "U" {
            summary.conflicted += 1;
        }
        if file.staged {
            summary.staged += 1;
        } else {
            summary.modified += 1;
        }
    }

    summary
}

/// Builds commit command args with explicit identity config.
fn commit_args(message: &str, name: &str, email: &str) -> Vec<String> {
    let mut args = vec![
        "-c".to_string(),
        format!("user.name={name}"),
        "-c".to_string(),
        format!("user.email={email}"),
        "commit".to_string(),
        "-m".to_string(),
        message.to_string(),
    ];
    if deny_hooks() {
        args.push("--no-verify".to_string());
    }
    args
}

/// Reads text for a specific conflict stage and path.
fn conflict_stage_text(path: &str, stage: u8) -> VcsResult<Option<String>> {
    let spec = format!(":{stage}:{path}");
    let output = run_git_in_repo_allow_failure(vec!["show".to_string(), spec])?;
    if output.success {
        Ok(Some(output.stdout))
    } else {
        Ok(None)
    }
}

/// Loads the current branch from symbolic-ref output.
fn load_current_branch() -> VcsResult<Option<String>> {
    let output = run_git_in_repo_allow_failure(vec![
        "symbolic-ref".to_string(),
        "--quiet".to_string(),
        "--short".to_string(),
        "HEAD".to_string(),
    ])?;
    if output.success {
        let branch = output.stdout.trim().to_string();
        if branch.is_empty() {
            Ok(None)
        } else {
            Ok(Some(branch))
        }
    } else {
        Ok(None)
    }
}

/// Plugin lifecycle and VCS entrypoint implementation.
struct GitPlugin;

impl plugin_api::Guest for GitPlugin {
    /// Initializes plugin state.
    fn init() -> Result<(), plugin_api::PluginError> {
        let _ = STATE.set(Mutex::new(PluginState::default()));
        Ok(())
    }

    /// Deinitializes plugin state.
    fn deinit() -> Result<(), plugin_api::PluginError> {
        if let Ok(mut state) = state_store().lock() {
            *state = PluginState::default();
            return Ok(());
        }
        Err(lifecycle_error(
            "plugin.state-error",
            "failed to acquire plugin state lock",
        ))
    }
}

impl vcs_api::Guest for GitPlugin {
    /// Returns capabilities supported by this backend.
    fn get_caps() -> VcsResult<vcs_api::Capabilities> {
        Ok(vcs_api::Capabilities {
            commits: true,
            branches: true,
            tags: false,
            staging: true,
            push_pull: true,
            fast_forward: true,
        })
    }

    /// Opens an existing repository at `path`.
    fn open(path: String, config: Vec<u8>) -> VcsResult<()> {
        let path = path.trim().to_string();
        if path.is_empty() {
            return Err(vcs_error("git.invalid-path", "path is empty"));
        }

        let _ = run_git(
            Some(path.as_str()),
            vec!["rev-parse".to_string(), "--is-inside-work-tree".to_string()],
            None,
        )?;

        set_settings(settings_from_config(&config));
        set_workdir(&path);
        Ok(())
    }

    /// Clones a repository to destination path and opens it.
    fn clone_repo(url: String, dest: String) -> VcsResult<()> {
        let url = url.trim().to_string();
        let dest = dest.trim().to_string();
        if url.is_empty() || dest.is_empty() {
            return Err(vcs_error("git.invalid-args", "url and dest are required"));
        }

        let _ = run_git(
            None,
            vec![
                "clone".to_string(),
                "--progress".to_string(),
                url,
                dest.clone(),
            ],
            None,
        )?;
        set_workdir(&dest);
        Ok(())
    }

    /// Returns the repository workdir.
    fn get_workdir() -> VcsResult<String> {
        require_workdir()
    }

    /// Returns the current branch when not detached.
    fn get_current_branch() -> VcsResult<Option<String>> {
        load_current_branch()
    }

    /// Returns local and remote branches.
    fn list_branches() -> VcsResult<Vec<vcs_api::BranchItem>> {
        let output = run_git_in_repo(
            vec![
                "for-each-ref".to_string(),
                "--format=%(refname)%x1f%(refname:short)%x1f%(HEAD)".to_string(),
                "refs/heads".to_string(),
                "refs/remotes".to_string(),
            ],
            None,
        )?;

        let items = parse_branches(&output)
            .into_iter()
            .filter(|branch| !branch.full_ref.ends_with("/HEAD"))
            .map(|branch| {
                let kind = if branch.full_ref.starts_with("refs/heads/") {
                    vcs_api::BranchKind::Local
                } else if let Some(rest) = branch.full_ref.strip_prefix("refs/remotes/") {
                    let remote = rest.split('/').next().unwrap_or_default().to_string();
                    vcs_api::BranchKind::Remote(remote)
                } else {
                    vcs_api::BranchKind::Unknown
                };

                vcs_api::BranchItem {
                    name: branch.short_name,
                    full_ref: branch.full_ref,
                    kind,
                    current: branch.current,
                }
            })
            .collect::<Vec<_>>();

        Ok(items)
    }

    /// Returns local branch names.
    fn list_local_branches() -> VcsResult<Vec<String>> {
        let text = run_git_in_repo(
            vec![
                "for-each-ref".to_string(),
                "--format=%(refname:short)".to_string(),
                "refs/heads".to_string(),
            ],
            None,
        )?;
        Ok(text
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(str::to_string)
            .collect::<Vec<_>>())
    }

    /// Creates a branch and optionally checks it out.
    fn create_branch(name: String, checkout: bool) -> VcsResult<()> {
        let name = name.trim();
        if name.is_empty() {
            return Err(vcs_error("git.invalid-args", "branch name is empty"));
        }

        let args = if checkout {
            vec!["switch".to_string(), "-c".to_string(), name.to_string()]
        } else {
            vec!["branch".to_string(), name.to_string()]
        };
        let _ = run_git_in_repo(args, None)?;
        Ok(())
    }

    /// Checks out an existing branch.
    fn checkout_branch(name: String) -> VcsResult<()> {
        let name = name.trim();
        if name.is_empty() {
            return Err(vcs_error("git.invalid-args", "branch name is empty"));
        }
        let _ = run_git_in_repo(vec!["switch".to_string(), name.to_string()], None)?;
        Ok(())
    }

    /// Adds or updates a remote URL.
    fn ensure_remote(name: String, url: String) -> VcsResult<()> {
        let name = name.trim().to_string();
        let url = url.trim().to_string();
        if name.is_empty() || url.is_empty() {
            return Err(vcs_error(
                "git.invalid-args",
                "remote name and url are required",
            ));
        }

        let existing = run_git_in_repo_allow_failure(vec![
            "remote".to_string(),
            "get-url".to_string(),
            name.clone(),
        ])?;

        if existing.success {
            let _ = run_git_in_repo(
                vec!["remote".to_string(), "set-url".to_string(), name, url],
                None,
            )?;
        } else {
            let _ = run_git_in_repo(
                vec!["remote".to_string(), "add".to_string(), name, url],
                None,
            )?;
        }

        Ok(())
    }

    /// Returns configured remotes.
    fn list_remotes() -> VcsResult<Vec<vcs_api::RemoteEntry>> {
        let text = run_git_in_repo(vec!["remote".to_string(), "-v".to_string()], None)?;
        let mut out = Vec::new();
        let mut seen = std::collections::HashSet::new();

        for line in text.lines() {
            let mut parts = line.split_whitespace();
            let name = parts.next().unwrap_or_default().trim();
            let url = parts.next().unwrap_or_default().trim();
            let kind = parts.next().unwrap_or_default().trim();
            if name.is_empty() || url.is_empty() || kind != "(fetch)" {
                continue;
            }
            let key = format!("{name}\t{url}");
            if seen.insert(key) {
                out.push(vcs_api::RemoteEntry {
                    name: name.to_string(),
                    url: url.to_string(),
                });
            }
        }

        Ok(out)
    }

    /// Removes a remote.
    fn remove_remote(name: String) -> VcsResult<()> {
        let name = name.trim();
        if name.is_empty() {
            return Err(vcs_error("git.invalid-args", "remote name is empty"));
        }
        let _ = run_git_in_repo(
            vec!["remote".to_string(), "remove".to_string(), name.into()],
            None,
        )?;
        Ok(())
    }

    /// Fetches from a remote.
    fn fetch(remote: String, refspec: String) -> VcsResult<()> {
        let mut args = vec!["fetch".to_string()];
        if snapshot_state().settings.prune_on_fetch {
            args.push("--prune".to_string());
        }
        let remote = remote.trim();
        let refspec = refspec.trim();
        if !remote.is_empty() {
            args.push(remote.to_string());
        }
        if !refspec.is_empty() {
            args.push(refspec.to_string());
        }
        let _ = run_git_in_repo(args, None)?;
        Ok(())
    }

    /// Fetches using explicit options.
    fn fetch_with_options(
        remote: String,
        refspec: String,
        opts: vcs_api::FetchOptions,
    ) -> VcsResult<()> {
        let mut args = vec!["fetch".to_string()];
        if opts.prune {
            args.push("--prune".to_string());
        }
        let remote = remote.trim();
        let refspec = refspec.trim();
        if !remote.is_empty() {
            args.push(remote.to_string());
        }
        if !refspec.is_empty() {
            args.push(refspec.to_string());
        }
        let _ = run_git_in_repo(args, None)?;
        Ok(())
    }

    /// Pushes to a remote.
    fn push(remote: String, refspec: String) -> VcsResult<()> {
        let mut args = vec!["push".to_string()];
        let remote = remote.trim();
        let refspec = refspec.trim();
        if !remote.is_empty() {
            args.push(remote.to_string());
        }
        if !refspec.is_empty() {
            args.push(refspec.to_string());
        }
        let _ = run_git_in_repo(args, None)?;
        Ok(())
    }

    /// Pulls from a remote branch in ff-only mode.
    fn pull_ff_only(remote: String, branch: String) -> VcsResult<()> {
        let mut args = vec!["pull".to_string(), "--ff-only".to_string()];
        let remote = remote.trim();
        let branch = branch.trim();
        if !remote.is_empty() {
            args.push(remote.to_string());
        }
        if !branch.is_empty() {
            args.push(branch.to_string());
        }
        let _ = run_git_in_repo(args, None)?;
        Ok(())
    }

    /// Commits selected paths.
    fn commit(
        message: String,
        name: String,
        email: String,
        paths: Vec<String>,
    ) -> VcsResult<String> {
        let message = message.trim().to_string();
        if message.is_empty() {
            return Err(vcs_error("git.invalid-args", "commit message is empty"));
        }

        if !paths.is_empty() {
            let mut add_args = vec!["add".to_string(), "--".to_string()];
            add_args.extend(paths);
            let _ = run_git_in_repo(add_args, None)?;
        }

        let _ = run_git_in_repo(commit_args(&message, &name, &email), None)?;
        let head = run_git_in_repo(vec!["rev-parse".to_string(), "HEAD".to_string()], None)?;
        Ok(head.trim().to_string())
    }

    /// Commits staged index contents.
    fn commit_index(message: String, name: String, email: String) -> VcsResult<String> {
        let message = message.trim().to_string();
        if message.is_empty() {
            return Err(vcs_error("git.invalid-args", "commit message is empty"));
        }

        let _ = run_git_in_repo(commit_args(&message, &name, &email), None)?;
        let head = run_git_in_repo(vec!["rev-parse".to_string(), "HEAD".to_string()], None)?;
        Ok(head.trim().to_string())
    }

    /// Returns compact status summary.
    fn get_status_summary() -> VcsResult<vcs_api::StatusSummary> {
        let payload = Self::get_status_payload()?;
        Ok(summarize_status(&payload))
    }

    /// Returns file-by-file status payload.
    fn get_status_payload() -> VcsResult<vcs_api::StatusPayload> {
        let text = run_git_in_repo(
            vec![
                "status".to_string(),
                "--porcelain=v2".to_string(),
                "--branch".to_string(),
                "--untracked-files=all".to_string(),
            ],
            None,
        )?;
        let parsed = parse_status_payload(&text);
        let files = parsed
            .files
            .into_iter()
            .map(|entry| vcs_api::FileEntry {
                path: entry.path,
                old_path: entry.old_path,
                status: entry.status,
                staged: entry.staged,
                resolved_conflict: !entry.conflicted,
                hunks: Vec::new(),
            })
            .collect::<Vec<_>>();

        Ok(vcs_api::StatusPayload {
            files,
            ahead: parsed.ahead,
            behind: parsed.behind,
        })
    }

    /// Returns commit history for the provided query.
    fn list_commits(query: vcs_api::LogQuery) -> VcsResult<Vec<vcs_api::CommitItem>> {
        let mut args = vec![
            "log".to_string(),
            "--date=iso-strict".to_string(),
            "--format=%H%x1f%s%x1f%cI%x1f%an <%ae>%x1e".to_string(),
        ];

        if query.topo_order {
            args.push("--topo-order".to_string());
        }
        if !query.include_merges {
            args.push("--no-merges".to_string());
        }
        if query.skip > 0 {
            args.push(format!("--skip={}", query.skip));
        }
        let limit = if query.limit == 0 {
            100
        } else {
            query.limit.min(1000)
        };
        args.push(format!("-n{limit}"));
        if let Some(value) = query
            .since_utc
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            args.push(format!("--since={value}"));
        }
        if let Some(value) = query
            .until_utc
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            args.push(format!("--until={value}"));
        }
        if let Some(value) = query
            .author_contains
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            args.push(format!("--author={value}"));
        }
        if let Some(value) = query
            .rev
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            args.push(value.to_string());
        }
        if let Some(value) = query
            .path
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            args.push("--".to_string());
            args.push(value.to_string());
        }

        let text = run_git_in_repo(args, None)?;
        Ok(parse_commits(&text)
            .into_iter()
            .map(|entry| vcs_api::CommitItem {
                id: entry.id,
                msg: entry.msg,
                meta: entry.meta,
                author: entry.author,
            })
            .collect::<Vec<_>>())
    }

    /// Returns line-oriented diff for a file.
    fn diff_file(path: String) -> VcsResult<Vec<String>> {
        let path = path.trim().to_string();
        if path.is_empty() {
            return Err(vcs_error("git.invalid-args", "path is empty"));
        }
        let out = run_git_in_repo(
            vec!["diff".to_string(), "--".to_string(), path.clone()],
            None,
        )?;
        if out.trim().is_empty() {
            let staged = run_git_in_repo(
                vec![
                    "diff".to_string(),
                    "--cached".to_string(),
                    "--".to_string(),
                    path,
                ],
                None,
            )?;
            return Ok(to_lines(&staged));
        }
        Ok(to_lines(&out))
    }

    /// Returns line-oriented patch for a commit/revision.
    fn diff_commit(rev: String) -> VcsResult<Vec<String>> {
        let rev = rev.trim().to_string();
        if rev.is_empty() {
            return Err(vcs_error("git.invalid-args", "revision is empty"));
        }
        let text = run_git_in_repo(
            vec![
                "show".to_string(),
                "--format=".to_string(),
                "--patch".to_string(),
                rev,
            ],
            None,
        )?;
        Ok(to_lines(&text))
    }

    /// Returns conflict details for a path.
    fn get_conflict_details(path: String) -> VcsResult<vcs_api::ConflictDetails> {
        let path = path.trim().to_string();
        if path.is_empty() {
            return Err(vcs_error("git.invalid-args", "path is empty"));
        }

        let base = conflict_stage_text(&path, 1)?;
        let ours = conflict_stage_text(&path, 2)?;
        let theirs = conflict_stage_text(&path, 3)?;

        Ok(vcs_api::ConflictDetails {
            path,
            ours,
            theirs,
            base,
            binary: false,
            lfs_pointer: false,
        })
    }

    /// Resolves conflict content with ours/theirs checkout.
    fn checkout_conflict_side(path: String, side: vcs_api::ConflictSide) -> VcsResult<()> {
        let path = path.trim().to_string();
        if path.is_empty() {
            return Err(vcs_error("git.invalid-args", "path is empty"));
        }
        let which = match side {
            vcs_api::ConflictSide::Ours => "--ours",
            vcs_api::ConflictSide::Theirs => "--theirs",
        };

        let _ = run_git_in_repo(
            vec![
                "checkout".to_string(),
                which.to_string(),
                "--".to_string(),
                path.clone(),
            ],
            None,
        )?;
        let _ = run_git_in_repo(vec!["add".to_string(), "--".to_string(), path], None)?;
        Ok(())
    }

    /// Writes merge result bytes and stages the file.
    fn write_merge_result(path: String, content: Vec<u8>) -> VcsResult<()> {
        let path = path.trim().to_string();
        if path.is_empty() {
            return Err(vcs_error("git.invalid-args", "path is empty"));
        }
        host_api::workspace_write_file(&path, &content).map_err(host_to_vcs_error)?;
        let _ = run_git_in_repo(vec!["add".to_string(), "--".to_string(), path], None)?;
        Ok(())
    }

    /// Stages a patch in the index.
    fn stage_patch(patch: String) -> VcsResult<()> {
        if patch.trim().is_empty() {
            return Ok(());
        }
        let _ = run_git_in_repo(
            vec![
                "apply".to_string(),
                "--cached".to_string(),
                "--unidiff-zero".to_string(),
                "--whitespace=nowarn".to_string(),
                "-".to_string(),
            ],
            Some(&patch),
        )?;
        Ok(())
    }

    /// Discards changes for explicit paths.
    fn discard_paths(paths: Vec<String>) -> VcsResult<()> {
        let cleaned = paths
            .into_iter()
            .map(|path| path.trim().to_string())
            .filter(|path| !path.is_empty())
            .collect::<Vec<_>>();
        if cleaned.is_empty() {
            return Ok(());
        }

        let mut restore_args = vec![
            "restore".to_string(),
            "--staged".to_string(),
            "--worktree".to_string(),
            "--".to_string(),
        ];
        restore_args.extend(cleaned.clone());

        let output = run_git_in_repo_allow_failure(restore_args)?;
        if output.success {
            return Ok(());
        }

        let mut checkout_args = vec!["checkout".to_string(), "--".to_string()];
        checkout_args.extend(cleaned);
        let _ = run_git_in_repo(checkout_args, None)?;
        Ok(())
    }

    /// Applies reverse patch content.
    fn apply_reverse_patch(patch: String) -> VcsResult<()> {
        if patch.trim().is_empty() {
            return Ok(());
        }
        let _ = run_git_in_repo(
            vec![
                "apply".to_string(),
                "-R".to_string(),
                "--whitespace=nowarn".to_string(),
                "-".to_string(),
            ],
            Some(&patch),
        )?;
        Ok(())
    }

    /// Deletes a local branch.
    fn delete_branch(name: String, force: bool) -> VcsResult<()> {
        let name = name.trim();
        if name.is_empty() {
            return Err(vcs_error("git.invalid-args", "branch name is empty"));
        }
        let flag = if force { "-D" } else { "-d" };
        let _ = run_git_in_repo(
            vec!["branch".to_string(), flag.to_string(), name.to_string()],
            None,
        )?;
        Ok(())
    }

    /// Renames a local branch.
    fn rename_branch(old: String, new: String) -> VcsResult<()> {
        let old = old.trim();
        let new = new.trim();
        if old.is_empty() || new.is_empty() {
            return Err(vcs_error(
                "git.invalid-args",
                "old and new names are required",
            ));
        }
        let _ = run_git_in_repo(
            vec![
                "branch".to_string(),
                "-m".to_string(),
                old.to_string(),
                new.to_string(),
            ],
            None,
        )?;
        Ok(())
    }

    /// Merges the named branch into the current branch.
    fn merge_into_current(name: String, message: Option<String>) -> VcsResult<()> {
        let name = name.trim();
        if name.is_empty() {
            return Err(vcs_error("git.invalid-args", "branch name is empty"));
        }

        let mut args = vec!["merge".to_string()];
        if let Some(message) = message
            .as_deref()
            .map(str::trim)
            .filter(|message| !message.is_empty())
        {
            args.push("--no-ff".to_string());
            args.push("-m".to_string());
            args.push(message.to_string());
        } else {
            args.push("--no-edit".to_string());
        }
        args.push(name.to_string());

        let _ = run_git_in_repo(args, None)?;
        Ok(())
    }

    /// Aborts an in-progress merge.
    fn merge_abort() -> VcsResult<()> {
        let _ = run_git_in_repo(vec!["merge".to_string(), "--abort".to_string()], None)?;
        Ok(())
    }

    /// Continues an in-progress merge.
    fn merge_continue() -> VcsResult<()> {
        let _ = run_git_in_repo(vec!["merge".to_string(), "--continue".to_string()], None)?;
        Ok(())
    }

    /// Returns whether merge state is active.
    fn is_merge_in_progress() -> VcsResult<bool> {
        let output = run_git_in_repo_allow_failure(vec![
            "rev-parse".to_string(),
            "-q".to_string(),
            "--verify".to_string(),
            "MERGE_HEAD".to_string(),
        ])?;
        Ok(output.success)
    }

    /// Sets upstream branch mapping.
    fn set_branch_upstream(branch: String, upstream: String) -> VcsResult<()> {
        let branch = branch.trim();
        let upstream = upstream.trim();
        if branch.is_empty() || upstream.is_empty() {
            return Err(vcs_error(
                "git.invalid-args",
                "branch and upstream are required",
            ));
        }
        let _ = run_git_in_repo(
            vec![
                "branch".to_string(),
                "--set-upstream-to".to_string(),
                upstream.to_string(),
                branch.to_string(),
            ],
            None,
        )?;
        Ok(())
    }

    /// Returns upstream branch mapping for a branch.
    fn get_branch_upstream(branch: String) -> VcsResult<Option<String>> {
        let branch = branch.trim();
        if branch.is_empty() {
            return Ok(None);
        }
        let output = run_git_in_repo_allow_failure(vec![
            "rev-parse".to_string(),
            "--abbrev-ref".to_string(),
            format!("{branch}@{{upstream}}"),
        ])?;
        if !output.success {
            return Ok(None);
        }
        let value = output.stdout.trim();
        if value.is_empty() {
            Ok(None)
        } else {
            Ok(Some(value.to_string()))
        }
    }

    /// Performs `git reset --hard HEAD`.
    fn hard_reset_head() -> VcsResult<()> {
        let _ = run_git_in_repo(
            vec![
                "reset".to_string(),
                "--hard".to_string(),
                "HEAD".to_string(),
            ],
            None,
        )?;
        Ok(())
    }

    /// Performs `git reset --soft <rev>`.
    fn reset_soft_to(rev: String) -> VcsResult<()> {
        let rev = rev.trim();
        if rev.is_empty() {
            return Err(vcs_error("git.invalid-args", "revision is empty"));
        }
        let _ = run_git_in_repo(
            vec!["reset".to_string(), "--soft".to_string(), rev.to_string()],
            None,
        )?;
        Ok(())
    }

    /// Returns configured commit identity.
    fn get_identity() -> VcsResult<Option<vcs_api::Identity>> {
        let name = run_git_in_repo_allow_failure(vec![
            "config".to_string(),
            "--get".to_string(),
            "user.name".to_string(),
        ])?;
        let email = run_git_in_repo_allow_failure(vec![
            "config".to_string(),
            "--get".to_string(),
            "user.email".to_string(),
        ])?;

        let name = if name.success {
            name.stdout.trim().to_string()
        } else {
            String::new()
        };
        let email = if email.success {
            email.stdout.trim().to_string()
        } else {
            String::new()
        };

        if name.is_empty() && email.is_empty() {
            Ok(None)
        } else {
            Ok(Some(vcs_api::Identity { name, email }))
        }
    }

    /// Sets local repository identity.
    fn set_identity_local(name: String, email: String) -> VcsResult<()> {
        let name = name.trim();
        let email = email.trim();
        if name.is_empty() || email.is_empty() {
            return Err(vcs_error("git.invalid-args", "name and email are required"));
        }

        let _ = run_git_in_repo(
            vec![
                "config".to_string(),
                "--local".to_string(),
                "user.name".to_string(),
                name.to_string(),
            ],
            None,
        )?;
        let _ = run_git_in_repo(
            vec![
                "config".to_string(),
                "--local".to_string(),
                "user.email".to_string(),
                email.to_string(),
            ],
            None,
        )?;
        Ok(())
    }

    /// Returns stash entries.
    fn list_stashes() -> VcsResult<Vec<vcs_api::StashItem>> {
        let text = run_git_in_repo(
            vec![
                "stash".to_string(),
                "list".to_string(),
                "--format=%gd%x1f%gs%x1f%cr".to_string(),
            ],
            None,
        )?;
        Ok(parse_stashes(&text)
            .into_iter()
            .map(|stash| vcs_api::StashItem {
                selector: stash.selector,
                msg: stash.msg,
                meta: stash.meta,
            })
            .collect::<Vec<_>>())
    }

    /// Creates a stash and returns its selector.
    fn stash_push(message: Option<String>, include_untracked: bool) -> VcsResult<String> {
        let mut args = vec!["stash".to_string(), "push".to_string()];
        if include_untracked {
            args.push("-u".to_string());
        }
        if let Some(message) = message
            .as_deref()
            .map(str::trim)
            .filter(|message| !message.is_empty())
        {
            args.push("-m".to_string());
            args.push(message.to_string());
        }

        let _ = run_git_in_repo(args, None)?;
        let top = run_git_in_repo_allow_failure(vec![
            "stash".to_string(),
            "list".to_string(),
            "--format=%gd".to_string(),
            "-n".to_string(),
            "1".to_string(),
        ])?;

        if top.success {
            let selector = top.stdout.trim();
            if !selector.is_empty() {
                return Ok(selector.to_string());
            }
        }
        Ok("stash@{0}".to_string())
    }

    /// Applies a stash entry.
    fn stash_apply(selector: String) -> VcsResult<()> {
        let selector = selector.trim();
        if selector.is_empty() {
            return Err(vcs_error("git.invalid-args", "selector is empty"));
        }
        let _ = run_git_in_repo(
            vec![
                "stash".to_string(),
                "apply".to_string(),
                selector.to_string(),
            ],
            None,
        )?;
        Ok(())
    }

    /// Pops a stash entry.
    fn stash_pop(selector: String) -> VcsResult<()> {
        let selector = selector.trim();
        if selector.is_empty() {
            return Err(vcs_error("git.invalid-args", "selector is empty"));
        }
        let _ = run_git_in_repo(
            vec!["stash".to_string(), "pop".to_string(), selector.to_string()],
            None,
        )?;
        Ok(())
    }

    /// Drops a stash entry.
    fn stash_drop(selector: String) -> VcsResult<()> {
        let selector = selector.trim();
        if selector.is_empty() {
            return Err(vcs_error("git.invalid-args", "selector is empty"));
        }
        let _ = run_git_in_repo(
            vec![
                "stash".to_string(),
                "drop".to_string(),
                selector.to_string(),
            ],
            None,
        )?;
        Ok(())
    }

    /// Returns stash patch text.
    fn stash_show(selector: String) -> VcsResult<String> {
        let selector = selector.trim();
        if selector.is_empty() {
            return Err(vcs_error("git.invalid-args", "selector is empty"));
        }
        run_git_in_repo(
            vec![
                "stash".to_string(),
                "show".to_string(),
                "-p".to_string(),
                selector.to_string(),
            ],
            None,
        )
    }

    /// Cherry-picks a commit.
    fn cherry_pick(commit: String) -> VcsResult<()> {
        let commit = commit.trim();
        if commit.is_empty() {
            return Err(vcs_error("git.invalid-args", "commit is empty"));
        }
        let mut args = vec!["cherry-pick".to_string(), commit.to_string()];
        if deny_hooks() {
            args.push("--no-verify".to_string());
        }
        let _ = run_git_in_repo(args, None)?;
        Ok(())
    }

    /// Reverts a commit.
    fn revert_commit(commit: String, no_edit: bool) -> VcsResult<()> {
        let commit = commit.trim();
        if commit.is_empty() {
            return Err(vcs_error("git.invalid-args", "commit is empty"));
        }
        let _ = no_edit;
        let mut args = vec!["revert".to_string()];
        args.push("--no-edit".to_string());
        if deny_hooks() {
            args.push("--no-verify".to_string());
        }
        args.push(commit.to_string());
        let _ = run_git_in_repo(args, None)?;
        Ok(())
    }
}

openvcs_core::bindings_vcs::export!(GitPlugin with_types_in openvcs_core::bindings_vcs);

#[cfg(test)]
mod tests {
    use super::{HookPolicy, settings_from_config};

    #[test]
    /// Verifies git settings are parsed from host open config bytes.
    fn settings_from_config_reads_git_section() {
        let settings = settings_from_config(
            br#"{"git":{"backend":"system","prune_on_fetch":false,"allow_hooks":"deny"}}"#,
        );
        assert!(!settings.prune_on_fetch);
        assert_eq!(settings.allow_hooks, HookPolicy::Deny);
    }

    #[test]
    /// Verifies malformed host config falls back to defaults.
    fn settings_from_config_falls_back_on_invalid_json() {
        let settings = settings_from_config(b"{");
        assert!(settings.prune_on_fetch);
        assert_eq!(settings.allow_hooks, HookPolicy::Ask);
    }
}
