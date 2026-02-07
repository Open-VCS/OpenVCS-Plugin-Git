#[cfg(feature = "system-git")]
mod system_git;

#[cfg(feature = "system-git")]
pub use system_git::{GitSystem, LfsLock, SubmoduleEntry};

#[cfg(feature = "libgit2")]
mod libgit2;

#[cfg(feature = "libgit2")]
pub use libgit2::GitLibGit2;

#[cfg(feature = "system-git")]
pub mod host_process {
    use std::path::Path;

    use openvcs_core::plugin_stdio::PluginError;
    use serde_json::json;

    #[derive(Debug, Clone)]
    pub struct ProcessExecOutput {
        pub success: bool,
        pub status: i32,
        pub stdout: String,
        pub stderr: String,
    }

    pub fn exec(
        cwd: Option<&Path>,
        args: &[String],
        env: &[(String, String)],
        stdin_text: Option<&str>,
    ) -> Result<ProcessExecOutput, String> {
        let env_obj = env
            .iter()
            .map(|(k, v)| (k.clone(), serde_json::Value::String(v.clone())))
            .collect::<serde_json::Map<_, _>>();
        let res = openvcs_core::host::call(
            "process.exec",
            json!({
              "program": "git",
              "cwd": cwd.and_then(|p| p.to_str()).unwrap_or(""),
              "args": args,
              "env": env_obj,
              "stdin": stdin_text.unwrap_or(""),
            }),
        )
        .map_err(|e: PluginError| {
            let code = e.code.unwrap_or_else(|| "host.error".into());
            format!("{code}: {}", e.message)
        })?;

        Ok(ProcessExecOutput {
            success: res
                .get("success")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
            status: res.get("status").and_then(|v| v.as_i64()).unwrap_or(-1) as i32,
            stdout: res
                .get("stdout")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            stderr: res
                .get("stderr")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
        })
    }
}

#[cfg(feature = "system-git")]
pub mod host_workspace {
    use openvcs_core::plugin_stdio::PluginError;
    use serde_json::json;

    pub fn read(path: &str) -> Result<Vec<u8>, String> {
        let res = openvcs_core::host::call("workspace.readFile", json!({ "path": path })).map_err(
            |e: PluginError| {
                let code = e.code.unwrap_or_else(|| "host.error".into());
                format!("{code}: {}", e.message)
            },
        )?;
        Ok(res.as_str().unwrap_or("").as_bytes().to_vec())
    }

    pub fn write(path: &str, bytes: &[u8]) -> Result<(), String> {
        let content = String::from_utf8_lossy(bytes).to_string();
        let _ = openvcs_core::host::call(
            "workspace.writeFile",
            json!({ "path": path, "content": content }),
        )
        .map_err(|e: PluginError| {
            let code = e.code.unwrap_or_else(|| "host.error".into());
            format!("{code}: {}", e.message)
        })?;
        Ok(())
    }
}
