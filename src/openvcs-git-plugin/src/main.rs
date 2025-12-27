use openvcs_core::models::{ConflictSide, FetchOptions, LogQuery, VcsEvent};
use openvcs_core::{OnEvent, Result as VcsResult, Vcs, VcsError};
use openvcs_plugin_protocol::{PluginMessage, RpcRequest, RpcResponse};
use serde::de::DeserializeOwned;
use serde_json::json;
use std::io::{self, BufRead, BufReader, LineWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone, Copy)]
enum BackendKind {
    GitSystem,
    GitLibgit2,
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

fn parse_json_params<T: DeserializeOwned>(value: serde_json::Value) -> Result<T, String> {
    serde_json::from_value(value).map_err(|e| format!("invalid params: {e}"))
}

fn write_message(out: &Arc<Mutex<LineWriter<io::Stdout>>>, msg: &PluginMessage) {
    if let Ok(mut w) = out.lock() {
        let _ = writeln!(w, "{}", serde_json::to_string(msg).unwrap_or_else(|_| "{}".into()));
        let _ = w.flush();
    }
}

fn respond_ok(
    out: &Arc<Mutex<LineWriter<io::Stdout>>>,
    id: u64,
    result: serde_json::Value,
) {
    write_message(
        out,
        &PluginMessage::Response(RpcResponse {
            id,
            ok: true,
            result,
            error: None,
        }),
    );
}

fn respond_err(out: &Arc<Mutex<LineWriter<io::Stdout>>>, id: u64, msg: String) {
    write_message(
        out,
        &PluginMessage::Response(RpcResponse {
            id,
            ok: false,
            result: serde_json::Value::Null,
            error: Some(msg),
        }),
    );
}

fn main() {
    env_logger::Builder::from_default_env()
        .format_timestamp(None)
        .init();

    let backend_kind = match parse_backend_kind() {
        Ok(k) => k,
        Err(e) => {
            eprintln!("openvcs-git-plugin: {e}");
            std::process::exit(2);
        }
    };

    let stdout = Arc::new(Mutex::new(LineWriter::new(io::stdout())));
    let stdin = BufReader::new(io::stdin());

    let mut repo: Option<Box<dyn Vcs>> = None;

    for line in stdin.lines().flatten() {
        if line.trim().is_empty() {
            continue;
        }

        let req: RpcRequest = match serde_json::from_str(&line) {
            Ok(r) => r,
            Err(e) => {
                eprintln!("openvcs-git-plugin: bad request: {e} (line={line})");
                continue;
            }
        };

        let out = Arc::clone(&stdout);
        let on: OnEvent = Arc::new(move |evt: VcsEvent| {
            write_message(&out, &PluginMessage::Event { event: evt });
        });

        let method = req.method.as_str();
        let params = req.params;

        let res: Result<serde_json::Value, String> = (|| match method {
            "open" => {
                #[derive(serde::Deserialize)]
                struct P {
                    path: String,
                }
                let p: P = parse_json_params(params)?;
                let path = PathBuf::from(p.path);
                repo = Some(match backend_kind {
                    BackendKind::GitSystem => {
                        #[cfg(feature = "system-git")]
                        {
                            Box::new(openvcs_git::GitSystem::open(&path).map_err(|e| e.to_string())?)
                        }
                        #[cfg(not(feature = "system-git"))]
                        {
                            return Err("git-system backend not compiled into plugin".to_string());
                        }
                    }
                    BackendKind::GitLibgit2 => {
                        #[cfg(feature = "libgit2")]
                        {
                            Box::new(
                                openvcs_git_libgit2::GitLibGit2::open(&path)
                                    .map_err(|e| e.to_string())?,
                            )
                        }
                        #[cfg(not(feature = "libgit2"))]
                        {
                            return Err("git-libgit2 backend not compiled into plugin".to_string());
                        }
                    }
                });
                Ok(json!({"workdir": require_utf8_path(repo.as_ref().unwrap().workdir()).map_err(|e| e.to_string())?}))
            }
            "clone" => {
                #[derive(serde::Deserialize)]
                struct P {
                    url: String,
                    dest: String,
                }
                let p: P = parse_json_params(params)?;
                let dest = PathBuf::from(p.dest);
                repo = Some(match backend_kind {
                    BackendKind::GitSystem => {
                        #[cfg(feature = "system-git")]
                        {
                            Box::new(
                                openvcs_git::GitSystem::clone(&p.url, &dest, Some(Arc::clone(&on)))
                                    .map_err(|e| e.to_string())?,
                            )
                        }
                        #[cfg(not(feature = "system-git"))]
                        {
                            return Err("git-system backend not compiled into plugin".to_string());
                        }
                    }
                    BackendKind::GitLibgit2 => {
                        #[cfg(feature = "libgit2")]
                        {
                            Box::new(
                                openvcs_git_libgit2::GitLibGit2::clone(
                                    &p.url,
                                    &dest,
                                    Some(Arc::clone(&on)),
                                )
                                .map_err(|e| e.to_string())?,
                            )
                        }
                        #[cfg(not(feature = "libgit2"))]
                        {
                            return Err("git-libgit2 backend not compiled into plugin".to_string());
                        }
                    }
                });
                Ok(json!({"workdir": require_utf8_path(repo.as_ref().unwrap().workdir()).map_err(|e| e.to_string())?}))
            }
            _ => {
                let repo = repo
                    .as_ref()
                    .ok_or_else(|| "repo is not open (call 'open' or 'clone' first)".to_string())?;

                match method {
                    "workdir" => Ok(json!(require_utf8_path(repo.workdir()).map_err(|e| e.to_string())?)),
                    "current_branch" => Ok(json!(repo.current_branch().map_err(|e| e.to_string())?)),
                    "branches" => Ok(json!(repo.branches().map_err(|e| e.to_string())?)),
                    "local_branches" => Ok(json!(repo.local_branches().map_err(|e| e.to_string())?)),
                    "create_branch" => {
                        #[derive(serde::Deserialize)]
                        struct P {
                            name: String,
                            checkout: bool,
                        }
                        let p: P = parse_json_params(params)?;
                        repo.create_branch(&p.name, p.checkout)
                            .map_err(|e| e.to_string())?;
                        Ok(serde_json::Value::Null)
                    }
                    "checkout_branch" => {
                        #[derive(serde::Deserialize)]
                        struct P {
                            name: String,
                        }
                        let p: P = parse_json_params(params)?;
                        repo.checkout_branch(&p.name).map_err(|e| e.to_string())?;
                        Ok(serde_json::Value::Null)
                    }
                    "ensure_remote" => {
                        #[derive(serde::Deserialize)]
                        struct P {
                            name: String,
                            url: String,
                        }
                        let p: P = parse_json_params(params)?;
                        repo.ensure_remote(&p.name, &p.url)
                            .map_err(|e| e.to_string())?;
                        Ok(serde_json::Value::Null)
                    }
                    "list_remotes" => Ok(json!(repo.list_remotes().map_err(|e| e.to_string())?)),
                    "remove_remote" => {
                        #[derive(serde::Deserialize)]
                        struct P {
                            name: String,
                        }
                        let p: P = parse_json_params(params)?;
                        repo.remove_remote(&p.name).map_err(|e| e.to_string())?;
                        Ok(serde_json::Value::Null)
                    }
                    "fetch" => {
                        #[derive(serde::Deserialize)]
                        struct P {
                            remote: String,
                            refspec: String,
                        }
                        let p: P = parse_json_params(params)?;
                        repo.fetch(&p.remote, &p.refspec, Some(Arc::clone(&on)))
                            .map_err(|e| e.to_string())?;
                        Ok(serde_json::Value::Null)
                    }
                    "fetch_with_options" => {
                        #[derive(serde::Deserialize)]
                        struct P {
                            remote: String,
                            refspec: String,
                            opts: FetchOptions,
                        }
                        let p: P = parse_json_params(params)?;
                        repo.fetch_with_options(
                            &p.remote,
                            &p.refspec,
                            p.opts,
                            Some(Arc::clone(&on)),
                        )
                        .map_err(|e| e.to_string())?;
                        Ok(serde_json::Value::Null)
                    }
                    "push" => {
                        #[derive(serde::Deserialize)]
                        struct P {
                            remote: String,
                            refspec: String,
                        }
                        let p: P = parse_json_params(params)?;
                        repo.push(&p.remote, &p.refspec, Some(Arc::clone(&on)))
                            .map_err(|e| e.to_string())?;
                        Ok(serde_json::Value::Null)
                    }
                    "pull_ff_only" => {
                        #[derive(serde::Deserialize)]
                        struct P {
                            remote: String,
                            branch: String,
                        }
                        let p: P = parse_json_params(params)?;
                        repo.pull_ff_only(&p.remote, &p.branch, Some(Arc::clone(&on)))
                            .map_err(|e| e.to_string())?;
                        Ok(serde_json::Value::Null)
                    }
                    "commit" => {
                        #[derive(serde::Deserialize)]
                        struct P {
                            message: String,
                            name: String,
                            email: String,
                            paths: Vec<String>,
                        }
                        let p: P = parse_json_params(params)?;
                        let paths: Vec<PathBuf> =
                            p.paths.into_iter().map(PathBuf::from).collect();
                        Ok(json!(repo
                            .commit(&p.message, &p.name, &p.email, &paths)
                            .map_err(|e| e.to_string())?))
                    }
                    "commit_index" => {
                        #[derive(serde::Deserialize)]
                        struct P {
                            message: String,
                            name: String,
                            email: String,
                        }
                        let p: P = parse_json_params(params)?;
                        Ok(json!(repo
                            .commit_index(&p.message, &p.name, &p.email)
                            .map_err(|e| e.to_string())?))
                    }
                    "status_summary" => Ok(json!(repo.status_summary().map_err(|e| e.to_string())?)),
                    "status_payload" => Ok(json!(repo.status_payload().map_err(|e| e.to_string())?)),
                    "log_commits" => {
                        #[derive(serde::Deserialize)]
                        struct P {
                            query: LogQuery,
                        }
                        let p: P = parse_json_params(params)?;
                        Ok(json!(repo.log_commits(&p.query).map_err(|e| e.to_string())?))
                    }
                    "diff_file" => {
                        #[derive(serde::Deserialize)]
                        struct P {
                            path: String,
                        }
                        let p: P = parse_json_params(params)?;
                        Ok(json!(repo.diff_file(Path::new(&p.path)).map_err(|e| e.to_string())?))
                    }
                    "diff_commit" => {
                        #[derive(serde::Deserialize)]
                        struct P {
                            rev: String,
                        }
                        let p: P = parse_json_params(params)?;
                        Ok(json!(repo.diff_commit(&p.rev).map_err(|e| e.to_string())?))
                    }
                    "conflict_details" => {
                        #[derive(serde::Deserialize)]
                        struct P {
                            path: String,
                        }
                        let p: P = parse_json_params(params)?;
                        Ok(json!(repo
                            .conflict_details(Path::new(&p.path))
                            .map_err(|e| e.to_string())?))
                    }
                    "checkout_conflict_side" => {
                        #[derive(serde::Deserialize)]
                        struct P {
                            path: String,
                            side: ConflictSide,
                        }
                        let p: P = parse_json_params(params)?;
                        repo.checkout_conflict_side(Path::new(&p.path), p.side)
                            .map_err(|e| e.to_string())?;
                        Ok(serde_json::Value::Null)
                    }
                    "write_merge_result" => {
                        #[derive(serde::Deserialize)]
                        struct P {
                            path: String,
                            content: String,
                        }
                        let p: P = parse_json_params(params)?;
                        repo.write_merge_result(Path::new(&p.path), p.content.as_bytes())
                            .map_err(|e| e.to_string())?;
                        Ok(serde_json::Value::Null)
                    }
                    "stage_patch" => {
                        #[derive(serde::Deserialize)]
                        struct P {
                            patch: String,
                        }
                        let p: P = parse_json_params(params)?;
                        repo.stage_patch(&p.patch).map_err(|e| e.to_string())?;
                        Ok(serde_json::Value::Null)
                    }
                    "discard_paths" => {
                        #[derive(serde::Deserialize)]
                        struct P {
                            paths: Vec<String>,
                        }
                        let p: P = parse_json_params(params)?;
                        let pb: Vec<PathBuf> =
                            p.paths.into_iter().map(PathBuf::from).collect();
                        repo.discard_paths(&pb).map_err(|e| e.to_string())?;
                        Ok(serde_json::Value::Null)
                    }
                    "apply_reverse_patch" => {
                        #[derive(serde::Deserialize)]
                        struct P {
                            patch: String,
                        }
                        let p: P = parse_json_params(params)?;
                        repo.apply_reverse_patch(&p.patch)
                            .map_err(|e| e.to_string())?;
                        Ok(serde_json::Value::Null)
                    }
                    "delete_branch" => {
                        #[derive(serde::Deserialize)]
                        struct P {
                            name: String,
                            force: bool,
                        }
                        let p: P = parse_json_params(params)?;
                        repo.delete_branch(&p.name, p.force)
                            .map_err(|e| e.to_string())?;
                        Ok(serde_json::Value::Null)
                    }
                    "rename_branch" => {
                        #[derive(serde::Deserialize)]
                        struct P {
                            old: String,
                            new: String,
                        }
                        let p: P = parse_json_params(params)?;
                        repo.rename_branch(&p.old, &p.new)
                            .map_err(|e| e.to_string())?;
                        Ok(serde_json::Value::Null)
                    }
                    "merge_into_current" => {
                        #[derive(serde::Deserialize)]
                        struct P {
                            name: String,
                        }
                        let p: P = parse_json_params(params)?;
                        repo.merge_into_current(&p.name).map_err(|e| e.to_string())?;
                        Ok(serde_json::Value::Null)
                    }
                    "merge_abort" => {
                        repo.merge_abort().map_err(|e| e.to_string())?;
                        Ok(serde_json::Value::Null)
                    }
                    "merge_continue" => {
                        repo.merge_continue().map_err(|e| e.to_string())?;
                        Ok(serde_json::Value::Null)
                    }
                    "merge_in_progress" => Ok(json!(repo.merge_in_progress().map_err(|e| e.to_string())?)),
                    "branch_upstream" => {
                        #[derive(serde::Deserialize)]
                        struct P {
                            branch: String,
                        }
                        let p: P = parse_json_params(params)?;
                        Ok(json!(repo.branch_upstream(&p.branch).map_err(|e| e.to_string())?))
                    }
                    "set_branch_upstream" => {
                        #[derive(serde::Deserialize)]
                        struct P {
                            branch: String,
                            upstream: String,
                        }
                        let p: P = parse_json_params(params)?;
                        repo.set_branch_upstream(&p.branch, &p.upstream)
                            .map_err(|e| e.to_string())?;
                        Ok(serde_json::Value::Null)
                    }
                    "hard_reset_head" => {
                        repo.hard_reset_head().map_err(|e| e.to_string())?;
                        Ok(serde_json::Value::Null)
                    }
                    "reset_soft_to" => {
                        #[derive(serde::Deserialize)]
                        struct P {
                            rev: String,
                        }
                        let p: P = parse_json_params(params)?;
                        repo.reset_soft_to(&p.rev).map_err(|e| e.to_string())?;
                        Ok(serde_json::Value::Null)
                    }
                    "get_identity" => Ok(json!(repo.get_identity().map_err(|e| e.to_string())?)),
                    "set_identity_local" => {
                        #[derive(serde::Deserialize)]
                        struct P {
                            name: String,
                            email: String,
                        }
                        let p: P = parse_json_params(params)?;
                        repo.set_identity_local(&p.name, &p.email)
                            .map_err(|e| e.to_string())?;
                        Ok(serde_json::Value::Null)
                    }
                    "stash_list" => Ok(json!(repo.stash_list().map_err(|e| e.to_string())?)),
                    "stash_push" => {
                        #[derive(serde::Deserialize)]
                        struct P {
                            message: String,
                            include_untracked: bool,
                            paths: Vec<String>,
                        }
                        let p: P = parse_json_params(params)?;
                        let pb: Vec<PathBuf> =
                            p.paths.into_iter().map(PathBuf::from).collect();
                        repo.stash_push(&p.message, p.include_untracked, &pb)
                            .map_err(|e| e.to_string())?;
                        Ok(serde_json::Value::Null)
                    }
                    "stash_apply" => {
                        #[derive(serde::Deserialize)]
                        struct P {
                            selector: String,
                        }
                        let p: P = parse_json_params(params)?;
                        repo.stash_apply(&p.selector).map_err(|e| e.to_string())?;
                        Ok(serde_json::Value::Null)
                    }
                    "stash_pop" => {
                        #[derive(serde::Deserialize)]
                        struct P {
                            selector: String,
                        }
                        let p: P = parse_json_params(params)?;
                        repo.stash_pop(&p.selector).map_err(|e| e.to_string())?;
                        Ok(serde_json::Value::Null)
                    }
                    "stash_drop" => {
                        #[derive(serde::Deserialize)]
                        struct P {
                            selector: String,
                        }
                        let p: P = parse_json_params(params)?;
                        repo.stash_drop(&p.selector).map_err(|e| e.to_string())?;
                        Ok(serde_json::Value::Null)
                    }
                    "stash_show" => {
                        #[derive(serde::Deserialize)]
                        struct P {
                            selector: String,
                        }
                        let p: P = parse_json_params(params)?;
                        Ok(json!(repo.stash_show(&p.selector).map_err(|e| e.to_string())?))
                    }
                    "lfs_fetch" => {
                        repo.lfs_fetch().map_err(|e| e.to_string())?;
                        Ok(serde_json::Value::Null)
                    }
                    "lfs_pull" => {
                        repo.lfs_pull().map_err(|e| e.to_string())?;
                        Ok(serde_json::Value::Null)
                    }
                    "lfs_prune" => {
                        repo.lfs_prune().map_err(|e| e.to_string())?;
                        Ok(serde_json::Value::Null)
                    }
                    "lfs_track" => {
                        #[derive(serde::Deserialize)]
                        struct P {
                            paths: Vec<String>,
                        }
                        let p: P = parse_json_params(params)?;
                        let pb: Vec<PathBuf> =
                            p.paths.into_iter().map(PathBuf::from).collect();
                        repo.lfs_track(&pb).map_err(|e| e.to_string())?;
                        Ok(serde_json::Value::Null)
                    }
                    "lfs_untrack" => {
                        #[derive(serde::Deserialize)]
                        struct P {
                            paths: Vec<String>,
                        }
                        let p: P = parse_json_params(params)?;
                        let pb: Vec<PathBuf> =
                            p.paths.into_iter().map(PathBuf::from).collect();
                        repo.lfs_untrack(&pb).map_err(|e| e.to_string())?;
                        Ok(serde_json::Value::Null)
                    }
                    "lfs_is_tracked" => {
                        #[derive(serde::Deserialize)]
                        struct P {
                            path: String,
                        }
                        let p: P = parse_json_params(params)?;
                        Ok(json!(repo.lfs_is_tracked(Path::new(&p.path)).map_err(|e| e.to_string())?))
                    }
                    "cherry_pick" => {
                        #[derive(serde::Deserialize)]
                        struct P {
                            rev: String,
                        }
                        let p: P = parse_json_params(params)?;
                        repo.cherry_pick(&p.rev).map_err(|e| e.to_string())?;
                        Ok(serde_json::Value::Null)
                    }
                    "revert_commit" => {
                        #[derive(serde::Deserialize)]
                        struct P {
                            rev: String,
                            no_edit: bool,
                        }
                        let p: P = parse_json_params(params)?;
                        repo.revert_commit(&p.rev, p.no_edit)
                            .map_err(|e| e.to_string())?;
                        Ok(serde_json::Value::Null)
                    }
                    other => Err(format!("unknown method '{other}'")),
                }
            }
        })();

        match res {
            Ok(val) => respond_ok(&stdout, req.id, val),
            Err(e) => respond_err(&stdout, req.id, e),
        }
    }
}
