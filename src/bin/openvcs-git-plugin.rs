use openvcs_core::models::{ConflictSide, FetchOptions, LogQuery, VcsEvent};
use openvcs_core::plugin_protocol::{PluginMessage, RpcRequest};
use openvcs_core::plugin_stdio::{
    PluginError, ok, ok_null, parse_json_params, receive_message, respond_shared, send_message_shared,
};
use openvcs_core::{models::BranchKind, OnEvent, Vcs, VcsError};
#[cfg(feature = "libgit2")]
use openvcs_plugin_git::GitLibGit2;
#[cfg(feature = "system-git")]
use openvcs_plugin_git::GitSystem;
use serde_json::json;
use std::io::{self, BufReader};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const HOST_CALL_TIMEOUT: Duration = Duration::from_secs(60);

fn to_plugin_error<E: std::fmt::Display>(err: E) -> PluginError {
    PluginError::message(err.to_string())
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

fn next_request(
    queue: &Arc<Mutex<std::collections::VecDeque<RpcRequest>>>,
    stdin: &Arc<Mutex<BufReader<io::Stdin>>>,
) -> Option<RpcRequest> {
    if let Ok(mut q) = queue.lock() {
        if let Some(req) = q.pop_front() {
            return Some(req);
        }
    }

    loop {
        let msg = {
            let mut lock = stdin.lock().ok()?;
            receive_message(&mut *lock)?
        };
        match msg {
            PluginMessage::Request(req) => return Some(req),
            PluginMessage::Response(_) | PluginMessage::Event { .. } => continue,
        }
    }
}

fn main() {
    let backend_kind = match parse_backend_kind() {
        Ok(k) => k,
        Err(e) => {
            eprintln!("openvcs-git-plugin: {e}");
            std::process::exit(2);
        }
    };

    #[cfg(all(feature = "system-git", target_arch = "wasm32"))]
    let next_id = 1u64 << 63;

    #[cfg(not(all(feature = "system-git", target_arch = "wasm32")))]
    let next_id = 1u64;

    let mut repo: Option<Box<dyn Vcs>> = None;

    openvcs_core::host::init_stdio_default(next_id, HOST_CALL_TIMEOUT);

    let stdout = Arc::clone(openvcs_core::host::stdout().unwrap());
    let stdin = Arc::clone(openvcs_core::host::stdin().unwrap());
    let queue = Arc::clone(openvcs_core::host::queue().unwrap());

    // `openvcs_core::host` now owns the stdio/queue/ids plumbing; plugins only call init.

    loop {
        let Some(req) = next_request(&queue, &stdin) else {
            break;
        };

        let out = Arc::clone(&stdout);
        let on: OnEvent = Arc::new(move |evt: VcsEvent| {
            send_message_shared(&out, &PluginMessage::Event { event: evt });
        });

        let method = req.method.as_str();
        let params = req.params;

        let res: Result<serde_json::Value, PluginError> = (|| match method {
            "caps" => ok(backend_caps(backend_kind)),
            "open" => {
                #[derive(serde::Deserialize)]
                struct P {
                    path: String,
                }
                let p: P = parse_json_params(params).map_err(PluginError::message)?;
                let path = PathBuf::from(p.path);
                repo = Some(match backend_kind {
                    BackendKind::GitSystem => {
                        #[cfg(feature = "system-git")]
                        {
                            Box::new(GitSystem::open(&path).map_err(to_plugin_error)?)
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
                            Box::new(GitLibGit2::open(&path).map_err(to_plugin_error)?)
                        }
                        #[cfg(not(feature = "libgit2"))]
                        {
                            return Err(PluginError::message(
                                "git-libgit2 backend not compiled into plugin",
                            ));
                        }
                    }
                });
                Ok(
                    json!({
                        "workdir": require_utf8_path(repo.as_ref().unwrap().workdir())
                            .map_err(to_plugin_error)?
                    }),
                )
            }
            "clone" => {
                #[derive(serde::Deserialize)]
                struct P {
                    url: String,
                    dest: String,
                }
                let p: P = parse_json_params(params).map_err(PluginError::message)?;
                let dest = PathBuf::from(p.dest);
                repo = Some(match backend_kind {
                    BackendKind::GitSystem => {
                        #[cfg(feature = "system-git")]
                        {
                            Box::new(
                                GitSystem::clone(&p.url, &dest, Some(Arc::clone(&on)))
                                    .map_err(to_plugin_error)?,
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
                                GitLibGit2::clone(&p.url, &dest, Some(Arc::clone(&on)))
                                    .map_err(to_plugin_error)?,
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
                Ok(
                    json!({
                        "workdir": require_utf8_path(repo.as_ref().unwrap().workdir())
                            .map_err(to_plugin_error)?
                    }),
                )
            }
            _ => {
                let repo = repo
                    .as_ref()
                    .ok_or_else(|| {
                        PluginError::message("repo is not open (call 'open' or 'clone' first)")
                    })?;

                match method {
                    "workdir" => Ok(json!(
                        require_utf8_path(repo.workdir()).map_err(to_plugin_error)?
                    )),
                    "current_branch" => {
                        Ok(json!(repo.current_branch().map_err(to_plugin_error)?))
                    }
                    "branches" => Ok(json!(repo.branches().map_err(to_plugin_error)?)),
                    "local_branches" => {
                        let locals: Vec<String> = repo
                            .branches()
                            .map_err(to_plugin_error)?
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
                        repo.create_branch(&p.name, p.checkout)
                            .map_err(to_plugin_error)?;
                        ok_null()
                    }
                    "checkout_branch" => {
                        #[derive(serde::Deserialize)]
                        struct P {
                            name: String,
                        }
                        let p: P = parse_json_params(params).map_err(PluginError::message)?;
                        repo.checkout_branch(&p.name).map_err(to_plugin_error)?;
                        ok_null()
                    }
                    "ensure_remote" => {
                        #[derive(serde::Deserialize)]
                        struct P {
                            name: String,
                            url: String,
                        }
                        let p: P = parse_json_params(params).map_err(PluginError::message)?;
                        repo.ensure_remote(&p.name, &p.url)
                            .map_err(to_plugin_error)?;
                        ok_null()
                    }
                    "list_remotes" => Ok(json!(repo.list_remotes().map_err(to_plugin_error)?)),
                    "remove_remote" => {
                        #[derive(serde::Deserialize)]
                        struct P {
                            name: String,
                        }
                        let p: P = parse_json_params(params).map_err(PluginError::message)?;
                        repo.remove_remote(&p.name).map_err(to_plugin_error)?;
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
                            .map_err(to_plugin_error)?;
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
                        repo.fetch_with_options(
                            &p.remote,
                            &p.refspec,
                            p.opts,
                            Some(Arc::clone(&on)),
                        )
                        .map_err(to_plugin_error)?;
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
                            .map_err(to_plugin_error)?;
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
                            .map_err(to_plugin_error)?;
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
                                .map_err(to_plugin_error)?
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
                                .map_err(to_plugin_error)?
                        ))
                    }
                    "status_summary" => {
                        Ok(json!(repo.status_summary().map_err(to_plugin_error)?))
                    }
                    "status_payload" => {
                        Ok(json!(repo.status_payload().map_err(to_plugin_error)?))
                    }
                    "log_commits" => {
                        #[derive(serde::Deserialize)]
                        struct P {
                            query: LogQuery,
                        }
                        let p: P = parse_json_params(params).map_err(PluginError::message)?;
                        Ok(json!(
                            repo.log_commits(&p.query).map_err(to_plugin_error)?
                        ))
                    }
                    "diff_file" => {
                        #[derive(serde::Deserialize)]
                        struct P {
                            path: String,
                        }
                        let p: P = parse_json_params(params).map_err(PluginError::message)?;
                        Ok(json!(
                            repo.diff_file(Path::new(&p.path))
                                .map_err(to_plugin_error)?
                        ))
                    }
                    "diff_commit" => {
                        #[derive(serde::Deserialize)]
                        struct P {
                            rev: String,
                        }
                        let p: P = parse_json_params(params).map_err(PluginError::message)?;
                        Ok(json!(repo.diff_commit(&p.rev).map_err(to_plugin_error)?))
                    }
                    "conflict_details" => {
                        #[derive(serde::Deserialize)]
                        struct P {
                            path: String,
                        }
                        let p: P = parse_json_params(params).map_err(PluginError::message)?;
                        Ok(json!(
                            repo.conflict_details(Path::new(&p.path))
                                .map_err(to_plugin_error)?
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
                            .map_err(to_plugin_error)?;
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
                            .map_err(to_plugin_error)?;
                        ok_null()
                    }
                    "stage_patch" => {
                        #[derive(serde::Deserialize)]
                        struct P {
                            patch: String,
                        }
                        let p: P = parse_json_params(params).map_err(PluginError::message)?;
                        repo.stage_patch(&p.patch).map_err(to_plugin_error)?;
                        ok_null()
                    }
                    "discard_paths" => {
                        #[derive(serde::Deserialize)]
                        struct P {
                            paths: Vec<String>,
                        }
                        let p: P = parse_json_params(params).map_err(PluginError::message)?;
                        let pb: Vec<PathBuf> = p.paths.into_iter().map(PathBuf::from).collect();
                        repo.discard_paths(&pb).map_err(to_plugin_error)?;
                        ok_null()
                    }
                    "apply_reverse_patch" => {
                        #[derive(serde::Deserialize)]
                        struct P {
                            patch: String,
                        }
                        let p: P = parse_json_params(params).map_err(PluginError::message)?;
                        repo.apply_reverse_patch(&p.patch)
                            .map_err(to_plugin_error)?;
                        ok_null()
                    }
                    "delete_branch" => {
                        #[derive(serde::Deserialize)]
                        struct P {
                            name: String,
                            force: bool,
                        }
                        let p: P = parse_json_params(params).map_err(PluginError::message)?;
                        repo.delete_branch(&p.name, p.force)
                            .map_err(to_plugin_error)?;
                        ok_null()
                    }
                    "rename_branch" => {
                        #[derive(serde::Deserialize)]
                        struct P {
                            old: String,
                            new: String,
                        }
                        let p: P = parse_json_params(params).map_err(PluginError::message)?;
                        repo.rename_branch(&p.old, &p.new)
                            .map_err(to_plugin_error)?;
                        ok_null()
                    }
                    "merge_into_current" => {
                        #[derive(serde::Deserialize)]
                        struct P {
                            name: String,
                        }
                        let p: P = parse_json_params(params).map_err(PluginError::message)?;
                        repo.merge_into_current(&p.name)
                            .map_err(to_plugin_error)?;
                        ok_null()
                    }
                    "merge_abort" => {
                        repo.merge_abort().map_err(to_plugin_error)?;
                        ok_null()
                    }
                    "merge_continue" => {
                        repo.merge_continue().map_err(to_plugin_error)?;
                        ok_null()
                    }
                    "merge_in_progress" => {
                        Ok(json!(repo.merge_in_progress().map_err(to_plugin_error)?))
                    }
                    "branch_upstream" => {
                        #[derive(serde::Deserialize)]
                        struct P {
                            branch: String,
                        }
                        let p: P = parse_json_params(params).map_err(PluginError::message)?;
                        Ok(json!(
                            repo.branch_upstream(&p.branch).map_err(to_plugin_error)?
                        ))
                    }
                    "set_branch_upstream" => {
                        #[derive(serde::Deserialize)]
                        struct P {
                            branch: String,
                            upstream: String,
                        }
                        let p: P = parse_json_params(params).map_err(PluginError::message)?;
                        repo.set_branch_upstream(&p.branch, &p.upstream)
                            .map_err(to_plugin_error)?;
                        ok_null()
                    }
                    "hard_reset_head" => {
                        repo.hard_reset_head().map_err(to_plugin_error)?;
                        ok_null()
                    }
                    "reset_soft_to" => {
                        #[derive(serde::Deserialize)]
                        struct P {
                            rev: String,
                        }
                        let p: P = parse_json_params(params).map_err(PluginError::message)?;
                        repo.reset_soft_to(&p.rev).map_err(to_plugin_error)?;
                        ok_null()
                    }
                    "get_identity" => Ok(json!(repo.get_identity().map_err(to_plugin_error)?)),
                    "set_identity_local" => {
                        #[derive(serde::Deserialize)]
                        struct P {
                            name: String,
                            email: String,
                        }
                        let p: P = parse_json_params(params).map_err(PluginError::message)?;
                        repo.set_identity_local(&p.name, &p.email)
                            .map_err(to_plugin_error)?;
                        ok_null()
                    }
                    "stash_list" => Ok(json!(repo.stash_list().map_err(to_plugin_error)?)),
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
                            .map_err(to_plugin_error)?;
                        ok_null()
                    }
                    "stash_apply" => {
                        #[derive(serde::Deserialize)]
                        struct P {
                            selector: String,
                        }
                        let p: P = parse_json_params(params).map_err(PluginError::message)?;
                        repo.stash_apply(&p.selector).map_err(to_plugin_error)?;
                        ok_null()
                    }
                    "stash_pop" => {
                        #[derive(serde::Deserialize)]
                        struct P {
                            selector: String,
                        }
                        let p: P = parse_json_params(params).map_err(PluginError::message)?;
                        repo.stash_pop(&p.selector).map_err(to_plugin_error)?;
                        ok_null()
                    }
                    "stash_drop" => {
                        #[derive(serde::Deserialize)]
                        struct P {
                            selector: String,
                        }
                        let p: P = parse_json_params(params).map_err(PluginError::message)?;
                        repo.stash_drop(&p.selector).map_err(to_plugin_error)?;
                        ok_null()
                    }
                    "stash_show" => {
                        #[derive(serde::Deserialize)]
                        struct P {
                            selector: String,
                        }
                        let p: P = parse_json_params(params).map_err(PluginError::message)?;
                        Ok(json!(
                            repo.stash_show(&p.selector).map_err(to_plugin_error)?
                        ))
                    }
                    "lfs_fetch" => {
                        repo.lfs_fetch().map_err(to_plugin_error)?;
                        ok_null()
                    }
                    "lfs_pull" => {
                        repo.lfs_pull().map_err(to_plugin_error)?;
                        ok_null()
                    }
                    "lfs_prune" => {
                        repo.lfs_prune().map_err(to_plugin_error)?;
                        ok_null()
                    }
                    "lfs_track" => {
                        #[derive(serde::Deserialize)]
                        struct P {
                            paths: Vec<String>,
                        }
                        let p: P = parse_json_params(params).map_err(PluginError::message)?;
                        let pb: Vec<PathBuf> = p.paths.into_iter().map(PathBuf::from).collect();
                        repo.lfs_track(&pb).map_err(to_plugin_error)?;
                        ok_null()
                    }
                    "lfs_untrack" => {
                        #[derive(serde::Deserialize)]
                        struct P {
                            paths: Vec<String>,
                        }
                        let p: P = parse_json_params(params).map_err(PluginError::message)?;
                        let pb: Vec<PathBuf> = p.paths.into_iter().map(PathBuf::from).collect();
                        repo.lfs_untrack(&pb).map_err(to_plugin_error)?;
                        ok_null()
                    }
                    "lfs_is_tracked" => {
                        #[derive(serde::Deserialize)]
                        struct P {
                            path: String,
                        }
                        let p: P = parse_json_params(params).map_err(PluginError::message)?;
                        Ok(json!(
                            repo.lfs_is_tracked(Path::new(&p.path))
                                .map_err(to_plugin_error)?
                        ))
                    }
                    "cherry_pick" => {
                        #[derive(serde::Deserialize)]
                        struct P {
                            rev: String,
                        }
                        let p: P = parse_json_params(params).map_err(PluginError::message)?;
                        repo.cherry_pick(&p.rev).map_err(to_plugin_error)?;
                        ok_null()
                    }
                    "revert_commit" => {
                        #[derive(serde::Deserialize)]
                        struct P {
                            rev: String,
                            no_edit: bool,
                        }
                        let p: P = parse_json_params(params).map_err(PluginError::message)?;
                        repo.revert_commit(&p.rev, p.no_edit)
                            .map_err(to_plugin_error)?;
                        ok_null()
                    }
                    other => Err(PluginError::message(format!("unknown method '{other}'"))),
                }
            }
        })();

        respond_shared(&stdout, req.id, res);
    }
}
