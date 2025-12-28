use openvcs_core::models::{ConflictSide, FetchOptions, LogQuery, VcsEvent};
use openvcs_core::plugin_protocol::PluginMessage;
use openvcs_core::plugin_protocol::RpcRequest;
use openvcs_core::plugin_runtime::{PluginCtx, register_delegate, run_registered};
use openvcs_core::plugin_stdio::{PluginError, err_display, ok, ok_null, parse_json_params, send_message_shared};
#[cfg(target_arch = "wasm32")]
use openvcs_core::events;
use openvcs_core::{models::BranchKind, OnEvent, Vcs, VcsError};
#[cfg(feature = "libgit2")]
use openvcs_plugin_git::GitLibGit2;
#[cfg(feature = "system-git")]
use openvcs_plugin_git::GitSystem;
use serde_json::json;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::{Mutex, OnceLock};

struct State {
    backend_kind: BackendKind,
    repo: Option<Box<dyn Vcs>>,
}

static STATE: OnceLock<Mutex<State>> = OnceLock::new();

fn state() -> Result<std::sync::MutexGuard<'static, State>, PluginError> {
    STATE
        .get()
        .ok_or_else(|| PluginError::message("plugin state not initialized"))?
        .lock()
        .map_err(|_| PluginError::message("state lock poisoned"))
}

#[cfg(target_arch = "wasm32")]
fn workspace_opened(payload: serde_json::Value) -> Result<(), PluginError> {
    #[derive(serde::Deserialize)]
    struct Payload {
        path: String,
    }
    let payload: Payload = serde_json::from_value(payload).map_err(err_display)?;
    let path = PathBuf::from(payload.path);

    let mut s = state()?;
    s.repo = Some(match s.backend_kind {
        BackendKind::GitSystem => {
            #[cfg(feature = "system-git")]
            {
                Box::new(GitSystem::open(&path).map_err(err_display)?)
            }
            #[cfg(not(feature = "system-git"))]
            {
                return Err(PluginError::message(
                    "git-system backend not compiled into plugin",
                ));
            }
        }
        BackendKind::GitLibgit2 => {
            #[cfg(feature = "libgit2")]
            {
                Box::new(GitLibGit2::open(&path).map_err(err_display)?)
            }
            #[cfg(not(feature = "libgit2"))]
            {
                return Err(PluginError::message(
                    "git-libgit2 backend not compiled into plugin",
                ));
            }
        }
    });

    Ok(())
}

fn caps_rpc(_ctx: &mut PluginCtx, _req: RpcRequest) -> Result<serde_json::Value, PluginError> {
    let s = state()?;
    ok(backend_caps(s.backend_kind))
}

fn on_event_sink(ctx: &mut PluginCtx) -> OnEvent {
    let out = ctx.stdout();
    Arc::new(move |evt: VcsEvent| {
        send_message_shared(&out, &PluginMessage::Event { event: evt });
    })
}

fn repo_required<'a>(s: &'a State) -> Result<&'a Box<dyn Vcs>, PluginError> {
    s.repo.as_ref().ok_or_else(|| {
        PluginError::message("repo is not open (call 'open' or 'clone' first)")
    })
}

fn dispatch_repo_rpc(
    ctx: &mut PluginCtx,
    method: &str,
    params: serde_json::Value,
) -> Result<serde_json::Value, PluginError> {
    let on = on_event_sink(ctx);
    let s = state()?;
    let repo = repo_required(&s)?;

    match method {
        "workdir" => Ok(json!(require_utf8_path(repo.workdir()).map_err(err_display)?)),
        "current_branch" => Ok(json!(repo.current_branch().map_err(err_display)?)),
        "branches" => Ok(json!(repo.branches().map_err(err_display)?)),
        "local_branches" => {
            let locals: Vec<String> = repo
                .branches()
                .map_err(err_display)?
                .into_iter()
                .filter(|b| b.kind == BranchKind::Local)
                .map(|b| b.name)
                .collect();
            Ok(json!(locals))
        }
        "create_branch" => {
            #[derive(serde::Deserialize)]
            struct P {
                name: String,
                checkout: bool,
            }
            let p: P = parse_json_params(params).map_err(PluginError::message)?;
            repo.create_branch(&p.name, p.checkout).map_err(err_display)?;
            ok_null()
        }
        "checkout_branch" => {
            #[derive(serde::Deserialize)]
            struct P {
                name: String,
            }
            let p: P = parse_json_params(params).map_err(PluginError::message)?;
            repo.checkout_branch(&p.name).map_err(err_display)?;
            ok_null()
        }
        "ensure_remote" => {
            #[derive(serde::Deserialize)]
            struct P {
                name: String,
                url: String,
            }
            let p: P = parse_json_params(params).map_err(PluginError::message)?;
            repo.ensure_remote(&p.name, &p.url).map_err(err_display)?;
            ok_null()
        }
        "list_remotes" => Ok(json!(repo.list_remotes().map_err(err_display)?)),
        "remove_remote" => {
            #[derive(serde::Deserialize)]
            struct P {
                name: String,
            }
            let p: P = parse_json_params(params).map_err(PluginError::message)?;
            repo.remove_remote(&p.name).map_err(err_display)?;
            ok_null()
        }
        "fetch" => {
            #[derive(serde::Deserialize)]
            struct P {
                remote: String,
                refspec: String,
            }
            let p: P = parse_json_params(params).map_err(PluginError::message)?;
            repo.fetch(&p.remote, &p.refspec, Some(Arc::clone(&on)))
                .map_err(err_display)?;
            ok_null()
        }
        "fetch_with_options" => {
            #[derive(serde::Deserialize)]
            struct P {
                remote: String,
                refspec: String,
                opts: FetchOptions,
            }
            let p: P = parse_json_params(params).map_err(PluginError::message)?;
            repo.fetch_with_options(&p.remote, &p.refspec, p.opts, Some(Arc::clone(&on)))
                .map_err(err_display)?;
            ok_null()
        }
        "push" => {
            #[derive(serde::Deserialize)]
            struct P {
                remote: String,
                refspec: String,
            }
            let p: P = parse_json_params(params).map_err(PluginError::message)?;
            repo.push(&p.remote, &p.refspec, Some(Arc::clone(&on)))
                .map_err(err_display)?;
            #[cfg(target_arch = "wasm32")]
            {
                let _ = events::emit("repo.pushed", json!({ "remote": p.remote, "refspec": p.refspec }));
            }
            ok_null()
        }
        "pull_ff_only" => {
            #[derive(serde::Deserialize)]
            struct P {
                remote: String,
                branch: String,
            }
            let p: P = parse_json_params(params).map_err(PluginError::message)?;
            repo.pull_ff_only(&p.remote, &p.branch, Some(Arc::clone(&on)))
                .map_err(err_display)?;
            ok_null()
        }
        "commit" => {
            #[derive(serde::Deserialize)]
            struct P {
                message: String,
                name: String,
                email: String,
                paths: Vec<String>,
            }
            let p: P = parse_json_params(params).map_err(PluginError::message)?;
            let paths: Vec<PathBuf> = p.paths.into_iter().map(PathBuf::from).collect();
            Ok(json!(
                repo.commit(&p.message, &p.name, &p.email, &paths)
                    .map_err(err_display)?
            ))
        }
        "commit_index" => {
            #[derive(serde::Deserialize)]
            struct P {
                message: String,
                name: String,
                email: String,
            }
            let p: P = parse_json_params(params).map_err(PluginError::message)?;
            Ok(json!(
                repo.commit_index(&p.message, &p.name, &p.email)
                    .map_err(err_display)?
            ))
        }
        "status_summary" => Ok(json!(repo.status_summary().map_err(err_display)?)),
        "status_payload" => Ok(json!(repo.status_payload().map_err(err_display)?)),
        "log_commits" => {
            #[derive(serde::Deserialize)]
            struct P {
                query: LogQuery,
            }
            let p: P = parse_json_params(params).map_err(PluginError::message)?;
            Ok(json!(repo.log_commits(&p.query).map_err(err_display)?))
        }
        "diff_file" => {
            #[derive(serde::Deserialize)]
            struct P {
                path: String,
            }
            let p: P = parse_json_params(params).map_err(PluginError::message)?;
            Ok(json!(
                repo.diff_file(Path::new(&p.path)).map_err(err_display)?
            ))
        }
        "diff_commit" => {
            #[derive(serde::Deserialize)]
            struct P {
                rev: String,
            }
            let p: P = parse_json_params(params).map_err(PluginError::message)?;
            Ok(json!(repo.diff_commit(&p.rev).map_err(err_display)?))
        }
        "conflict_details" => {
            #[derive(serde::Deserialize)]
            struct P {
                path: String,
            }
            let p: P = parse_json_params(params).map_err(PluginError::message)?;
            Ok(json!(
                repo.conflict_details(Path::new(&p.path))
                    .map_err(err_display)?
            ))
        }
        "checkout_conflict_side" => {
            #[derive(serde::Deserialize)]
            struct P {
                path: String,
                side: ConflictSide,
            }
            let p: P = parse_json_params(params).map_err(PluginError::message)?;
            repo.checkout_conflict_side(Path::new(&p.path), p.side)
                .map_err(err_display)?;
            ok_null()
        }
        "write_merge_result" => {
            #[derive(serde::Deserialize)]
            struct P {
                path: String,
                content: String,
            }
            let p: P = parse_json_params(params).map_err(PluginError::message)?;
            repo.write_merge_result(Path::new(&p.path), p.content.as_bytes())
                .map_err(err_display)?;
            ok_null()
        }
        "stage_patch" => {
            #[derive(serde::Deserialize)]
            struct P {
                patch: String,
            }
            let p: P = parse_json_params(params).map_err(PluginError::message)?;
            repo.stage_patch(&p.patch).map_err(err_display)?;
            ok_null()
        }
        "discard_paths" => {
            #[derive(serde::Deserialize)]
            struct P {
                paths: Vec<String>,
            }
            let p: P = parse_json_params(params).map_err(PluginError::message)?;
            let pb: Vec<PathBuf> = p.paths.into_iter().map(PathBuf::from).collect();
            repo.discard_paths(&pb).map_err(err_display)?;
            ok_null()
        }
        "apply_reverse_patch" => {
            #[derive(serde::Deserialize)]
            struct P {
                patch: String,
            }
            let p: P = parse_json_params(params).map_err(PluginError::message)?;
            repo.apply_reverse_patch(&p.patch).map_err(err_display)?;
            ok_null()
        }
        "delete_branch" => {
            #[derive(serde::Deserialize)]
            struct P {
                name: String,
                force: bool,
            }
            let p: P = parse_json_params(params).map_err(PluginError::message)?;
            repo.delete_branch(&p.name, p.force).map_err(err_display)?;
            ok_null()
        }
        "rename_branch" => {
            #[derive(serde::Deserialize)]
            struct P {
                old: String,
                new: String,
            }
            let p: P = parse_json_params(params).map_err(PluginError::message)?;
            repo.rename_branch(&p.old, &p.new).map_err(err_display)?;
            ok_null()
        }
        "merge_into_current" => {
            #[derive(serde::Deserialize)]
            struct P {
                name: String,
            }
            let p: P = parse_json_params(params).map_err(PluginError::message)?;
            repo.merge_into_current(&p.name).map_err(err_display)?;
            ok_null()
        }
        "merge_abort" => {
            repo.merge_abort().map_err(err_display)?;
            ok_null()
        }
        "merge_continue" => {
            repo.merge_continue().map_err(err_display)?;
            ok_null()
        }
        "merge_in_progress" => Ok(json!(repo.merge_in_progress().map_err(err_display)?)),
        "branch_upstream" => {
            #[derive(serde::Deserialize)]
            struct P {
                branch: String,
            }
            let p: P = parse_json_params(params).map_err(PluginError::message)?;
            Ok(json!(repo.branch_upstream(&p.branch).map_err(err_display)?))
        }
        "set_branch_upstream" => {
            #[derive(serde::Deserialize)]
            struct P {
                branch: String,
                upstream: String,
            }
            let p: P = parse_json_params(params).map_err(PluginError::message)?;
            repo.set_branch_upstream(&p.branch, &p.upstream)
                .map_err(err_display)?;
            ok_null()
        }
        "hard_reset_head" => {
            repo.hard_reset_head().map_err(err_display)?;
            ok_null()
        }
        "reset_soft_to" => {
            #[derive(serde::Deserialize)]
            struct P {
                rev: String,
            }
            let p: P = parse_json_params(params).map_err(PluginError::message)?;
            repo.reset_soft_to(&p.rev).map_err(err_display)?;
            ok_null()
        }
        "get_identity" => Ok(json!(repo.get_identity().map_err(err_display)?)),
        "set_identity_local" => {
            #[derive(serde::Deserialize)]
            struct P {
                name: String,
                email: String,
            }
            let p: P = parse_json_params(params).map_err(PluginError::message)?;
            repo.set_identity_local(&p.name, &p.email).map_err(err_display)?;
            ok_null()
        }
        "stash_list" => Ok(json!(repo.stash_list().map_err(err_display)?)),
        "stash_push" => {
            #[derive(serde::Deserialize)]
            struct P {
                message: String,
                include_untracked: bool,
                paths: Vec<String>,
            }
            let p: P = parse_json_params(params).map_err(PluginError::message)?;
            let pb: Vec<PathBuf> = p.paths.into_iter().map(PathBuf::from).collect();
            repo.stash_push(&p.message, p.include_untracked, &pb)
                .map_err(err_display)?;
            ok_null()
        }
        "stash_apply" => {
            #[derive(serde::Deserialize)]
            struct P {
                selector: String,
            }
            let p: P = parse_json_params(params).map_err(PluginError::message)?;
            repo.stash_apply(&p.selector).map_err(err_display)?;
            ok_null()
        }
        "stash_pop" => {
            #[derive(serde::Deserialize)]
            struct P {
                selector: String,
            }
            let p: P = parse_json_params(params).map_err(PluginError::message)?;
            repo.stash_pop(&p.selector).map_err(err_display)?;
            ok_null()
        }
        "stash_drop" => {
            #[derive(serde::Deserialize)]
            struct P {
                selector: String,
            }
            let p: P = parse_json_params(params).map_err(PluginError::message)?;
            repo.stash_drop(&p.selector).map_err(err_display)?;
            ok_null()
        }
        "stash_show" => {
            #[derive(serde::Deserialize)]
            struct P {
                selector: String,
            }
            let p: P = parse_json_params(params).map_err(PluginError::message)?;
            Ok(json!(repo.stash_show(&p.selector).map_err(err_display)?))
        }
        "lfs_fetch" => {
            repo.lfs_fetch().map_err(err_display)?;
            ok_null()
        }
        "lfs_pull" => {
            repo.lfs_pull().map_err(err_display)?;
            ok_null()
        }
        "lfs_prune" => {
            repo.lfs_prune().map_err(err_display)?;
            ok_null()
        }
        "lfs_track" => {
            #[derive(serde::Deserialize)]
            struct P {
                paths: Vec<String>,
            }
            let p: P = parse_json_params(params).map_err(PluginError::message)?;
            let pb: Vec<PathBuf> = p.paths.into_iter().map(PathBuf::from).collect();
            repo.lfs_track(&pb).map_err(err_display)?;
            ok_null()
        }
        "lfs_untrack" => {
            #[derive(serde::Deserialize)]
            struct P {
                paths: Vec<String>,
            }
            let p: P = parse_json_params(params).map_err(PluginError::message)?;
            let pb: Vec<PathBuf> = p.paths.into_iter().map(PathBuf::from).collect();
            repo.lfs_untrack(&pb).map_err(err_display)?;
            ok_null()
        }
        "lfs_is_tracked" => {
            #[derive(serde::Deserialize)]
            struct P {
                path: String,
            }
            let p: P = parse_json_params(params).map_err(PluginError::message)?;
            Ok(json!(repo.lfs_is_tracked(Path::new(&p.path)).map_err(err_display)?))
        }
        "cherry_pick" => {
            #[derive(serde::Deserialize)]
            struct P {
                rev: String,
            }
            let p: P = parse_json_params(params).map_err(PluginError::message)?;
            repo.cherry_pick(&p.rev).map_err(err_display)?;
            ok_null()
        }
        "revert_commit" => {
            #[derive(serde::Deserialize)]
            struct P {
                rev: String,
                no_edit: bool,
            }
            let p: P = parse_json_params(params).map_err(PluginError::message)?;
            repo.revert_commit(&p.rev, p.no_edit).map_err(err_display)?;
            ok_null()
        }
        other => Err(PluginError::message(format!("unknown method '{other}'"))),
    }
}

macro_rules! define_repo_rpc {
    ($fn_name:ident, $method:literal) => {
        fn $fn_name(ctx: &mut PluginCtx, req: RpcRequest) -> Result<serde_json::Value, PluginError> {
            dispatch_repo_rpc(ctx, $method, req.params)
        }
    };
}

define_repo_rpc!(pull_ff_only_rpc, "pull_ff_only");
define_repo_rpc!(create_branch_rpc, "create_branch");
define_repo_rpc!(checkout_branch_rpc, "checkout_branch");
define_repo_rpc!(ensure_remote_rpc, "ensure_remote");
define_repo_rpc!(list_remotes_rpc, "list_remotes");
define_repo_rpc!(remove_remote_rpc, "remove_remote");
define_repo_rpc!(fetch_rpc, "fetch");
define_repo_rpc!(fetch_with_options_rpc, "fetch_with_options");
define_repo_rpc!(push_rpc, "push");
define_repo_rpc!(commit_rpc, "commit");
define_repo_rpc!(commit_index_rpc, "commit_index");
define_repo_rpc!(status_summary_rpc, "status_summary");
define_repo_rpc!(status_payload_rpc, "status_payload");
define_repo_rpc!(log_commits_rpc, "log_commits");
define_repo_rpc!(diff_file_rpc, "diff_file");
define_repo_rpc!(diff_commit_rpc, "diff_commit");
define_repo_rpc!(conflict_details_rpc, "conflict_details");
define_repo_rpc!(checkout_conflict_side_rpc, "checkout_conflict_side");
define_repo_rpc!(write_merge_result_rpc, "write_merge_result");
define_repo_rpc!(stage_patch_rpc, "stage_patch");
define_repo_rpc!(discard_paths_rpc, "discard_paths");
define_repo_rpc!(apply_reverse_patch_rpc, "apply_reverse_patch");
define_repo_rpc!(delete_branch_rpc, "delete_branch");
define_repo_rpc!(rename_branch_rpc, "rename_branch");
define_repo_rpc!(merge_into_current_rpc, "merge_into_current");
define_repo_rpc!(merge_abort_rpc, "merge_abort");
define_repo_rpc!(merge_continue_rpc, "merge_continue");
define_repo_rpc!(merge_in_progress_rpc, "merge_in_progress");
define_repo_rpc!(branch_upstream_rpc, "branch_upstream");
define_repo_rpc!(set_branch_upstream_rpc, "set_branch_upstream");
define_repo_rpc!(hard_reset_head_rpc, "hard_reset_head");
define_repo_rpc!(reset_soft_to_rpc, "reset_soft_to");
define_repo_rpc!(get_identity_rpc, "get_identity");
define_repo_rpc!(set_identity_local_rpc, "set_identity_local");
define_repo_rpc!(stash_list_rpc, "stash_list");
define_repo_rpc!(stash_push_rpc, "stash_push");
define_repo_rpc!(stash_apply_rpc, "stash_apply");
define_repo_rpc!(stash_pop_rpc, "stash_pop");
define_repo_rpc!(stash_drop_rpc, "stash_drop");
define_repo_rpc!(stash_show_rpc, "stash_show");
define_repo_rpc!(lfs_fetch_rpc, "lfs_fetch");
define_repo_rpc!(lfs_pull_rpc, "lfs_pull");
define_repo_rpc!(lfs_prune_rpc, "lfs_prune");
define_repo_rpc!(lfs_track_rpc, "lfs_track");
define_repo_rpc!(lfs_untrack_rpc, "lfs_untrack");
define_repo_rpc!(lfs_is_tracked_rpc, "lfs_is_tracked");
define_repo_rpc!(cherry_pick_rpc, "cherry_pick");
define_repo_rpc!(revert_commit_rpc, "revert_commit");
fn open_rpc(_ctx: &mut PluginCtx, req: RpcRequest) -> Result<serde_json::Value, PluginError> {
    #[derive(serde::Deserialize)]
    struct P {
        path: String,
    }
    let p: P = parse_json_params(req.params).map_err(PluginError::message)?;
    let path = PathBuf::from(&p.path);

    let mut s = state()?;
    s.repo = Some(match s.backend_kind {
        BackendKind::GitSystem => {
            #[cfg(feature = "system-git")]
            {
                Box::new(GitSystem::open(&path).map_err(err_display)?)
            }
            #[cfg(not(feature = "system-git"))]
            {
                return Err(PluginError::message(
                    "git-system backend not compiled into plugin",
                ));
            }
        }
        BackendKind::GitLibgit2 => {
            #[cfg(feature = "libgit2")]
            {
                Box::new(GitLibGit2::open(&path).map_err(err_display)?)
            }
            #[cfg(not(feature = "libgit2"))]
            {
                return Err(PluginError::message(
                    "git-libgit2 backend not compiled into plugin",
                ));
            }
        }
    });

    let workdir = require_utf8_path(s.repo.as_ref().unwrap().workdir()).map_err(err_display)?;
    #[cfg(target_arch = "wasm32")]
    {
        let _ = events::emit("repo.opened", json!({ "path": p.path, "workdir": workdir }));
    }
    Ok(json!({ "workdir": workdir }))
}

fn clone_rpc(ctx: &mut PluginCtx, req: RpcRequest) -> Result<serde_json::Value, PluginError> {
    #[derive(serde::Deserialize)]
    struct P {
        url: String,
        dest: String,
    }
    let p: P = parse_json_params(req.params).map_err(PluginError::message)?;
    let dest = PathBuf::from(&p.dest);
    let on = on_event_sink(ctx);

    let mut s = state()?;
    s.repo = Some(match s.backend_kind {
        BackendKind::GitSystem => {
            #[cfg(feature = "system-git")]
            {
                Box::new(
                    GitSystem::clone(&p.url, &dest, Some(Arc::clone(&on))).map_err(err_display)?,
                )
            }
            #[cfg(not(feature = "system-git"))]
            {
                return Err(PluginError::message(
                    "git-system backend not compiled into plugin",
                ));
            }
        }
        BackendKind::GitLibgit2 => {
            #[cfg(feature = "libgit2")]
            {
                Box::new(
                    GitLibGit2::clone(&p.url, &dest, Some(Arc::clone(&on))).map_err(err_display)?,
                )
            }
            #[cfg(not(feature = "libgit2"))]
            {
                return Err(PluginError::message(
                    "git-libgit2 backend not compiled into plugin",
                ));
            }
        }
    });

    let workdir = require_utf8_path(s.repo.as_ref().unwrap().workdir()).map_err(err_display)?;
    #[cfg(target_arch = "wasm32")]
    {
        let _ = events::emit(
            "repo.opened",
            json!({ "path": dest.to_string_lossy(), "workdir": workdir, "cloned_from": p.url }),
        );
    }
    Ok(json!({ "workdir": workdir }))
}

fn workdir_rpc(_ctx: &mut PluginCtx, _req: RpcRequest) -> Result<serde_json::Value, PluginError> {
    let s = state()?;
    let repo = repo_required(&s)?;
    Ok(json!(require_utf8_path(repo.workdir()).map_err(err_display)?))
}

fn current_branch_rpc(_ctx: &mut PluginCtx, _req: RpcRequest) -> Result<serde_json::Value, PluginError> {
    let s = state()?;
    let repo = repo_required(&s)?;
    Ok(json!(repo.current_branch().map_err(err_display)?))
}

fn branches_rpc(_ctx: &mut PluginCtx, _req: RpcRequest) -> Result<serde_json::Value, PluginError> {
    let s = state()?;
    let repo = repo_required(&s)?;
    Ok(json!(repo.branches().map_err(err_display)?))
}

fn local_branches_rpc(_ctx: &mut PluginCtx, _req: RpcRequest) -> Result<serde_json::Value, PluginError> {
    let s = state()?;
    let repo = repo_required(&s)?;
    let locals: Vec<String> = repo
        .branches()
        .map_err(err_display)?
        .into_iter()
        .filter(|b| b.kind == BranchKind::Local)
        .map(|b| b.name)
        .collect();
    Ok(json!(locals))
}

#[derive(Debug, Clone, Copy)]
enum BackendKind {
    GitSystem,
    GitLibgit2,
}

fn backend_caps(kind: BackendKind) -> openvcs_core::models::Capabilities {
    use openvcs_core::models::Capabilities;
    match kind {
        BackendKind::GitSystem => Capabilities {
            commits: true,
            branches: true,
            tags: true,
            staging: true,
            push_pull: true,
            fast_forward: true,
        },
        BackendKind::GitLibgit2 => Capabilities {
            commits: true,
            branches: true,
            tags: true,
            staging: true,
            push_pull: true,
            fast_forward: true,
        },
    }
}

fn parse_backend_kind() -> Result<BackendKind, String> {
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        if arg == "--backend" {
            let val = args
                .next()
                .ok_or_else(|| "missing value for --backend".to_string())?;
            return match val.as_str() {
                "git-system" => Ok(BackendKind::GitSystem),
                "git-libgit2" => Ok(BackendKind::GitLibgit2),
                other => Err(format!("unknown backend '{other}'")),
            };
        }
    }
    Err("missing required argument: --backend <git-system|git-libgit2>".to_string())
}

fn require_utf8_path(p: &Path) -> Result<String, VcsError> {
    p.to_str()
        .map(|s| s.to_string())
        .ok_or_else(|| VcsError::Backend {
            backend: openvcs_core::BackendId::from("plugin"),
            msg: "non-utf8 path".to_string(),
        })
}

fn main() {
    let backend_kind = match parse_backend_kind() {
        Ok(k) => k,
        Err(e) => {
            eprintln!("openvcs-git-plugin: {e}");
            std::process::exit(2);
        }
    };


    let _ = STATE.set(Mutex::new(State {
        backend_kind,
        repo: None,
    }));

    #[cfg(target_arch = "wasm32")]
    {
        let _ = events::subscribe("workspace.opened", workspace_opened);
    }

    register_delegate("caps", caps_rpc);
    register_delegate("open", open_rpc);
    register_delegate("clone", clone_rpc);
    register_delegate("workdir", workdir_rpc);
    register_delegate("current_branch", current_branch_rpc);
    register_delegate("branches", branches_rpc);
    register_delegate("local_branches", local_branches_rpc);
    register_delegate("create_branch", create_branch_rpc);
    register_delegate("checkout_branch", checkout_branch_rpc);
    register_delegate("ensure_remote", ensure_remote_rpc);
    register_delegate("list_remotes", list_remotes_rpc);
    register_delegate("remove_remote", remove_remote_rpc);
    register_delegate("fetch", fetch_rpc);
    register_delegate("fetch_with_options", fetch_with_options_rpc);
    register_delegate("push", push_rpc);
    register_delegate("pull_ff_only", pull_ff_only_rpc);
    register_delegate("commit", commit_rpc);
    register_delegate("commit_index", commit_index_rpc);
    register_delegate("status_summary", status_summary_rpc);
    register_delegate("status_payload", status_payload_rpc);
    register_delegate("log_commits", log_commits_rpc);
    register_delegate("diff_file", diff_file_rpc);
    register_delegate("diff_commit", diff_commit_rpc);
    register_delegate("conflict_details", conflict_details_rpc);
    register_delegate("checkout_conflict_side", checkout_conflict_side_rpc);
    register_delegate("write_merge_result", write_merge_result_rpc);
    register_delegate("stage_patch", stage_patch_rpc);
    register_delegate("discard_paths", discard_paths_rpc);
    register_delegate("apply_reverse_patch", apply_reverse_patch_rpc);
    register_delegate("delete_branch", delete_branch_rpc);
    register_delegate("rename_branch", rename_branch_rpc);
    register_delegate("merge_into_current", merge_into_current_rpc);
    register_delegate("merge_abort", merge_abort_rpc);
    register_delegate("merge_continue", merge_continue_rpc);
    register_delegate("merge_in_progress", merge_in_progress_rpc);
    register_delegate("branch_upstream", branch_upstream_rpc);
    register_delegate("set_branch_upstream", set_branch_upstream_rpc);
    register_delegate("hard_reset_head", hard_reset_head_rpc);
    register_delegate("reset_soft_to", reset_soft_to_rpc);
    register_delegate("get_identity", get_identity_rpc);
    register_delegate("set_identity_local", set_identity_local_rpc);
    register_delegate("stash_list", stash_list_rpc);
    register_delegate("stash_push", stash_push_rpc);
    register_delegate("stash_apply", stash_apply_rpc);
    register_delegate("stash_pop", stash_pop_rpc);
    register_delegate("stash_drop", stash_drop_rpc);
    register_delegate("stash_show", stash_show_rpc);
    register_delegate("lfs_fetch", lfs_fetch_rpc);
    register_delegate("lfs_pull", lfs_pull_rpc);
    register_delegate("lfs_prune", lfs_prune_rpc);
    register_delegate("lfs_track", lfs_track_rpc);
    register_delegate("lfs_untrack", lfs_untrack_rpc);
    register_delegate("lfs_is_tracked", lfs_is_tracked_rpc);
    register_delegate("cherry_pick", cherry_pick_rpc);
    register_delegate("revert_commit", revert_commit_rpc);

    if let Err(e) = run_registered() {
        eprintln!("openvcs-git-plugin: {e}");
        std::process::exit(1);
    }
}
