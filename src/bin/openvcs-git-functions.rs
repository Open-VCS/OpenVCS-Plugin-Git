use openvcs_core::plugin_protocol::{PluginMessage, RpcRequest, RpcResponse};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::{self, BufRead, BufReader, LineWriter, Write};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const HOST_CALL_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug)]
struct PendingHostCalls {
    next_id: u64,
    pending: HashMap<u64, std::sync::mpsc::Sender<RpcResponse>>,
}

fn write_message(out: &Arc<Mutex<LineWriter<io::Stdout>>>, msg: &PluginMessage) {
    if let Ok(mut w) = out.lock() {
        let _ = writeln!(
            w,
            "{}",
            serde_json::to_string(msg).unwrap_or_else(|_| "{}".into())
        );
        let _ = w.flush();
    }
}

fn respond_ok(out: &Arc<Mutex<LineWriter<io::Stdout>>>, id: u64, result: Value) {
    write_message(
        out,
        &PluginMessage::Response(RpcResponse {
            id,
            ok: true,
            result,
            error: None,
            error_code: None,
            error_data: None,
        }),
    );
}

fn respond_err(out: &Arc<Mutex<LineWriter<io::Stdout>>>, id: u64, code: &str, msg: String) {
    write_message(
        out,
        &PluginMessage::Response(RpcResponse {
            id,
            ok: false,
            result: Value::Null,
            error: Some(msg),
            error_code: Some(code.to_string()),
            error_data: None,
        }),
    );
}

fn host_call(
    out: &Arc<Mutex<LineWriter<io::Stdout>>>,
    pending: &Arc<Mutex<PendingHostCalls>>,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    let (id, rx) = {
        let (tx, rx) = std::sync::mpsc::channel::<RpcResponse>();
        let mut lock = pending.lock().map_err(|_| "pending lock poisoned")?;
        let id = lock.next_id;
        lock.next_id = lock.next_id.saturating_add(1);
        lock.pending.insert(id, tx);
        (id, rx)
    };

    write_message(
        out,
        &PluginMessage::Request(RpcRequest {
            id,
            method: method.to_string(),
            params,
        }),
    );

    let resp = rx
        .recv_timeout(HOST_CALL_TIMEOUT)
        .map_err(|_| "host call timed out")?;
    if resp.ok {
        Ok(resp.result)
    } else {
        let code = resp.error_code.unwrap_or_else(|| "host.error".into());
        let msg = resp.error.unwrap_or_else(|| "error".into());
        Err(format!("{code}: {msg}"))
    }
}

fn functions_list() -> Value {
    json!([
      { "id": "hello.echo", "name": "Echo", "description": "Returns args as-is." },
      { "id": "demo.notify", "name": "Notify", "description": "Requests ui.notify from the host." },
      { "id": "demo.readFile", "name": "Read File", "description": "Requests workspace.readFile from the host (should be denied without workspace.read)." }
    ])
}

fn main() {
    let stdout = Arc::new(Mutex::new(LineWriter::new(io::stdout())));
    let stdin = BufReader::new(io::stdin());

    let pending: Arc<Mutex<PendingHostCalls>> = Arc::new(Mutex::new(PendingHostCalls {
        next_id: 10_000,
        pending: HashMap::new(),
    }));

    let (tx, rx) = std::sync::mpsc::channel::<PluginMessage>();

    // Read stdin in a dedicated thread so handlers can synchronously call back into the host.
    std::thread::spawn(move || {
        for line in stdin.lines().map_while(Result::ok) {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let msg: PluginMessage = match serde_json::from_str(trimmed) {
                Ok(m) => m,
                Err(_) => continue,
            };
            let _ = tx.send(msg);
        }
    });

    while let Ok(msg) = rx.recv() {
        match msg {
            PluginMessage::Request(req) => {
                let method = req.method.as_str();
                let params = req.params;

                match method {
                    "functions.list" => respond_ok(&stdout, req.id, functions_list()),
                    "functions.invoke" => {
                        let id = params.get("id").and_then(|v| v.as_str()).unwrap_or("");
                        let args = params.get("args").cloned().unwrap_or(Value::Null);

                        match id {
                            "hello.echo" => respond_ok(&stdout, req.id, args),
                            "demo.notify" => {
                                let msg = args
                                    .get("message")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("Hello from plugin")
                                    .to_string();
                                let res = host_call(
                                    &stdout,
                                    &pending,
                                    "ui.notify",
                                    json!({ "message": msg }),
                                );
                                match res {
                                    Ok(_) => respond_ok(&stdout, req.id, Value::Null),
                                    Err(e) => respond_err(&stdout, req.id, "host_call.failed", e),
                                }
                            }
                            "demo.readFile" => {
                                let path = args
                                    .get("path")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("README.md")
                                    .to_string();
                                let res = host_call(
                                    &stdout,
                                    &pending,
                                    "workspace.readFile",
                                    json!({ "path": path }),
                                );
                                match res {
                                    Ok(v) => respond_ok(&stdout, req.id, v),
                                    Err(e) => respond_err(&stdout, req.id, "host_call.failed", e),
                                }
                            }
                            _ => respond_err(
                                &stdout,
                                req.id,
                                "function.not_found",
                                format!("unknown function id: {id}"),
                            ),
                        }
                    }
                    _ => respond_err(
                        &stdout,
                        req.id,
                        "method.not_found",
                        format!("unknown method: {method}"),
                    ),
                }
            }
            PluginMessage::Response(resp) => {
                if let Ok(mut lock) = pending.lock() {
                    if let Some(tx) = lock.pending.remove(&resp.id) {
                        let _ = tx.send(resp);
                    }
                }
            }
            PluginMessage::Event { .. } => {}
        }
    }
}
