use openvcs_core::models::{ConflictSide, FetchOptions, LogQuery, VcsEvent};
use openvcs_core::plugin_protocol::{PluginMessage, RpcRequest};
#[cfg(all(feature = "system-git", target_arch = "wasm32"))]
use openvcs_core::plugin_protocol::RpcResponse;
use openvcs_core::plugin_stdio::{
    PluginError, parse_json_params, read_message, respond_shared, write_message_shared,
};
use openvcs_core::{OnEvent, Vcs, VcsError, models::BranchKind};
#[cfg(feature = "libgit2")]
use openvcs_plugin_git::GitLibGit2;
#[cfg(feature = "system-git")]
use openvcs_plugin_git::GitSystem;
#[cfg(all(feature = "system-git", target_arch = "wasm32"))]
use openvcs_plugin_git::host_exec::{HostExecOutput, set_host_exec};
#[cfg(all(feature = "system-git", target_arch = "wasm32"))]
use openvcs_plugin_git::host_workspace;
use serde_json::json;
#[cfg(all(feature = "system-git", target_arch = "wasm32"))]
use std::collections::HashMap;
use std::collections::VecDeque;
use std::io::{self, BufReader, LineWriter};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
#[cfg(all(feature = "system-git", target_arch = "wasm32"))]
use std::time::Duration;

#[cfg(all(feature = "system-git", target_arch = "wasm32"))]
const HOST_CALL_TIMEOUT: Duration = Duration::from_secs(60);

#[cfg(all(feature = "system-git", target_arch = "wasm32"))]
#[derive(Debug)]
struct PendingHostCalls {
    next_id: u64,
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

#[cfg(all(feature = "system-git", target_arch = "wasm32"))]
fn host_call(
    out: &Arc<Mutex<LineWriter<io::Stdout>>>,
    stdin: &Arc<Mutex<BufReader<io::Stdin>>>,
    queue: &Arc<Mutex<VecDeque<RpcRequest>>>,
    pending: &Arc<Mutex<PendingHostCalls>>,
    method: &str,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let id = {
        let mut lock = pending.lock().map_err(|_| "pending lock poisoned")?;
        let id = lock.next_id;
        lock.next_id = lock.next_id.saturating_add(1);
        id
    };

    write_message_shared(
        out,
        &PluginMessage::Request(RpcRequest {
            id,
            method: method.to_string(),
            params,
        }),
    );

    let deadline = std::time::Instant::now() + HOST_CALL_TIMEOUT;
    let mut stash: HashMap<u64, RpcResponse> = HashMap::new();

    loop {
        if std::time::Instant::now() > deadline {
            return Err("host call timed out".to_string());
        }

        if let Some(resp) = stash.remove(&id) {
            return if resp.ok {
                Ok(resp.result)
            } else {
                let code = resp.error_code.unwrap_or_else(|| "host.error".into());
                let msg = resp.error.unwrap_or_else(|| "error".into());
                Err(format!("{code}: {msg}"))
            };
        }

        let msg = {
            let mut lock = stdin.lock().map_err(|_| "stdin lock poisoned")?;
            read_message(&mut *lock).ok_or_else(|| "host closed stdin".to_string())?
        };

        match msg {
            PluginMessage::Response(resp) => {
                if resp.id == id {
                    return if resp.ok {
                        Ok(resp.result)
                    } else {
                        let code = resp.error_code.unwrap_or_else(|| "host.error".into());
                        let msg = resp.error.unwrap_or_else(|| "error".into());
                        Err(format!("{code}: {msg}"))
                    };
                }
                stash.insert(resp.id, resp);
            }
            PluginMessage::Request(req) => {
                if let Ok(mut q) = queue.lock() {
                    q.push_back(req);
                }
            }
            PluginMessage::Event { .. } => {}
        }
    }
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
    let stdin = Arc::new(Mutex::new(BufReader::new(io::stdin())));
    let queue: Arc<Mutex<VecDeque<RpcRequest>>> = Arc::new(Mutex::new(VecDeque::new()));

    let mut repo: Option<Box<dyn Vcs>> = None;

    #[cfg(all(feature = "system-git", target_arch = "wasm32"))]
    let pending: Arc<Mutex<PendingHostCalls>> = Arc::new(Mutex::new(PendingHostCalls {
        // Reserve low ids for host->plugin calls.
        next_id: 1u64 << 63,
    }));

    #[cfg(all(feature = "system-git", target_arch = "wasm32"))]
    {
        let out_exec = Arc::clone(&stdout);
        let stdin_exec = Arc::clone(&stdin);
        let queue_exec = Arc::clone(&queue);
        let pending_exec = Arc::clone(&pending);
        set_host_exec(Arc::new(move |cwd, args, env, stdin_text| {
            let env_obj = env
                .iter()
                .map(|(k, v)| (k.clone(), serde_json::Value::String(v.clone())))
                .collect::<serde_json::Map<_, _>>();
            let res = host_call(
                &out_exec,
                &stdin_exec,
                &queue_exec,
                &pending_exec,
                "process.exec",
                serde_json::json!({
                    "program": "git",
                    "cwd": cwd.and_then(|p| p.to_str()).unwrap_or(""),
                    "args": args,
                    "env": env_obj,
                    "stdin": stdin_text.unwrap_or(""),
                }),
            )?;
            Ok(HostExecOutput {
                success: res.get("success").and_then(|v| v.as_bool()).unwrap_or(false),
                status: res.get("status").and_then(|v| v.as_i64()).unwrap_or(-1) as i32,
                stdout: res.get("stdout").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                stderr: res.get("stderr").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            })
        }));

        let out_read = Arc::clone(&stdout);
        let stdin_read = Arc::clone(&stdin);
        let queue_read = Arc::clone(&queue);
        let pending_read = Arc::clone(&pending);
        host_workspace::set_read(Arc::new(move |path: &str| {
            let res = host_call(
                &out_read,
                &stdin_read,
                &queue_read,
                &pending_read,
                "workspace.readFile",
                serde_json::json!({ "path": path }),
            )?;
            Ok(res.as_str().unwrap_or("").as_bytes().to_vec())
        }));

        let out_write = Arc::clone(&stdout);
        let stdin_write = Arc::clone(&stdin);
        let queue_write = Arc::clone(&queue);
        let pending_write = Arc::clone(&pending);
        host_workspace::set_write(Arc::new(move |path: &str, bytes: &[u8]| {
            let content = String::from_utf8_lossy(bytes).to_string();
            let _ = host_call(
                &out_write,
                &stdin_write,
                &queue_write,
                &pending_write,
                "workspace.writeFile",
                serde_json::json!({ "path": path, "content": content }),
            )?;
            Ok(())
        }));
    }

    loop {
        let req = if let Ok(mut q) = queue.lock() {
            q.pop_front()
        } else {
            None
        };

        let req = if let Some(req) = req {
            req
        } else {
            let msg = {
                let mut lock = stdin.lock().unwrap();
                match read_message(&mut *lock) {
                    Some(m) => m,
                    None => break,
                }
            };
            match msg {
                PluginMessage::Request(req) => req,
                PluginMessage::Response(_) | PluginMessage::Event { .. } => continue,
            }
        };

        let out = Arc::clone(&stdout);
        let on: OnEvent = Arc::new(move |evt: VcsEvent| {
            write_message_shared(&out, &PluginMessage::Event { event: evt });
        });

        let method = req.method.as_str();
        let params = req.params;

        let res: Result<serde_json::Value, String> = (|| match method {
            "caps" => Ok(json!(backend_caps(backend_kind))),
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
                            Box::new(
                                GitSystem::open(&path).map_err(|e| e.to_string())?,
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
                                GitLibGit2::open(&path).map_err(|e| e.to_string())?,
                            )
                        }
                        #[cfg(not(feature = "libgit2"))]
                        {
                            return Err("git-libgit2 backend not compiled into plugin".to_string());
                        }
                    }
                });
                Ok(
                    json!({"workdir": require_utf8_path(repo.as_ref().unwrap().workdir()).map_err(|e| e.to_string())?}),
                )
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
                                GitSystem::clone(&p.url, &dest, Some(Arc::clone(&on)))
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
                                GitLibGit2::clone(&p.url, &dest, Some(Arc::clone(&on)))
                                    .map_err(|e| e.to_string())?,
                            )
                        }
                        #[cfg(not(feature = "libgit2"))]
                        {
                            return Err("git-libgit2 backend not compiled into plugin".to_string());
                        }
                    }
                });
                Ok(
                    json!({"workdir": require_utf8_path(repo.as_ref().unwrap().workdir()).map_err(|e| e.to_string())?}),
                )
            }
            _ => {
                let repo = repo
                    .as_ref()
                    .ok_or_else(|| "repo is not open (call 'open' or 'clone' first)".to_string())?;

                match method {
                    "workdir" => Ok(json!(
                        require_utf8_path(repo.workdir()).map_err(|e| e.to_string())?
                    )),
                    "current_branch" => {
                        Ok(json!(repo.current_branch().map_err(|e| e.to_string())?))
                    }
                    "branches" => Ok(json!(repo.branches().map_err(|e| e.to_string())?)),
                    "local_branches" => {
                        let locals: Vec<String> = repo
                            .branches()
                            .map_err(|e| e.to_string())?
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
                        let paths: Vec<PathBuf> = p.paths.into_iter().map(PathBuf::from).collect();
                        Ok(json!(
                            repo.commit(&p.message, &p.name, &p.email, &paths)
                                .map_err(|e| e.to_string())?
                        ))
                    }
                    "commit_index" => {
                        #[derive(serde::Deserialize)]
                        struct P {
                            message: String,
                            name: String,
                            email: String,
                        }
                        let p: P = parse_json_params(params)?;
                        Ok(json!(
                            repo.commit_index(&p.message, &p.name, &p.email)
                                .map_err(|e| e.to_string())?
                        ))
                    }
                    "status_summary" => {
                        Ok(json!(repo.status_summary().map_err(|e| e.to_string())?))
                    }
                    "status_payload" => {
                        Ok(json!(repo.status_payload().map_err(|e| e.to_string())?))
                    }
                    "log_commits" => {
                        #[derive(serde::Deserialize)]
                        struct P {
                            query: LogQuery,
                        }
                        let p: P = parse_json_params(params)?;
                        Ok(json!(
                            repo.log_commits(&p.query).map_err(|e| e.to_string())?
                        ))
                    }
                    "diff_file" => {
                        #[derive(serde::Deserialize)]
                        struct P {
                            path: String,
                        }
                        let p: P = parse_json_params(params)?;
                        Ok(json!(
                            repo.diff_file(Path::new(&p.path))
                                .map_err(|e| e.to_string())?
                        ))
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
                        Ok(json!(
                            repo.conflict_details(Path::new(&p.path))
                                .map_err(|e| e.to_string())?
                        ))
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
                        let pb: Vec<PathBuf> = p.paths.into_iter().map(PathBuf::from).collect();
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
                        repo.merge_into_current(&p.name)
                            .map_err(|e| e.to_string())?;
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
                    "merge_in_progress" => {
                        Ok(json!(repo.merge_in_progress().map_err(|e| e.to_string())?))
                    }
                    "branch_upstream" => {
                        #[derive(serde::Deserialize)]
                        struct P {
                            branch: String,
                        }
                        let p: P = parse_json_params(params)?;
                        Ok(json!(
                            repo.branch_upstream(&p.branch).map_err(|e| e.to_string())?
                        ))
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
                        let pb: Vec<PathBuf> = p.paths.into_iter().map(PathBuf::from).collect();
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
                        Ok(json!(
                            repo.stash_show(&p.selector).map_err(|e| e.to_string())?
                        ))
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
                        let pb: Vec<PathBuf> = p.paths.into_iter().map(PathBuf::from).collect();
                        repo.lfs_track(&pb).map_err(|e| e.to_string())?;
                        Ok(serde_json::Value::Null)
                    }
                    "lfs_untrack" => {
                        #[derive(serde::Deserialize)]
                        struct P {
                            paths: Vec<String>,
                        }
                        let p: P = parse_json_params(params)?;
                        let pb: Vec<PathBuf> = p.paths.into_iter().map(PathBuf::from).collect();
                        repo.lfs_untrack(&pb).map_err(|e| e.to_string())?;
                        Ok(serde_json::Value::Null)
                    }
                    "lfs_is_tracked" => {
                        #[derive(serde::Deserialize)]
                        struct P {
                            path: String,
                        }
                        let p: P = parse_json_params(params)?;
                        Ok(json!(
                            repo.lfs_is_tracked(Path::new(&p.path))
                                .map_err(|e| e.to_string())?
                        ))
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
            Ok(val) => respond_shared(&stdout, req.id, Ok(val)),
            Err(e) => respond_shared(&stdout, req.id, Err(PluginError::message(e))),
        }
    }
}
