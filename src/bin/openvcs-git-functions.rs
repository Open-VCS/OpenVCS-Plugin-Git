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
}

fn read_message<R: BufRead>(stdin: &mut R) -> Option<PluginMessage> {
    let mut line = String::new();
    loop {
        line.clear();
        let n = stdin.read_line(&mut line).ok()?;
        if n == 0 {
            return None;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Ok(msg) = serde_json::from_str::<PluginMessage>(trimmed) {
            return Some(msg);
        }
    }
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
    state: &mut PendingHostCalls,
    stdin: &mut impl BufRead,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    let id = state.next_id;
    state.next_id = state.next_id.saturating_add(1);

    write_message(
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

        let msg = read_message(stdin).ok_or_else(|| "host closed stdin".to_string())?;
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
            // Ignore any other messages while waiting for the host response.
            PluginMessage::Request(_) | PluginMessage::Event { .. } => {}
        }
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
    let mut stdin = BufReader::new(io::stdin());

    let mut pending = PendingHostCalls { next_id: 10_000 };

    while let Some(msg) = read_message(&mut stdin) {
        if let PluginMessage::Request(req) = msg {
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
                                &mut pending,
                                &mut stdin,
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
                                &mut pending,
                                &mut stdin,
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
    }
}
