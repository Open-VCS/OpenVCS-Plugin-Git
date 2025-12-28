#[cfg(feature = "system-git")]
mod system_git;

#[cfg(feature = "system-git")]
pub use system_git::GitSystem;

#[cfg(feature = "libgit2")]
mod libgit2;

#[cfg(feature = "libgit2")]
pub use libgit2::GitLibGit2;

#[cfg(feature = "system-git")]
pub mod host_process {
    use std::path::Path;
    use std::sync::{Arc, OnceLock};

    #[derive(Debug, Clone)]
    pub struct ProcessExecOutput {
        pub success: bool,
        pub status: i32,
        pub stdout: String,
        pub stderr: String,
    }

    pub type ProcessExecFn = dyn Fn(
            Option<&Path>,
            &[String],
            &[(String, String)],
            Option<&str>,
        ) -> Result<ProcessExecOutput, String>
        + Send
        + Sync
        + 'static;

    static PROCESS_EXEC: OnceLock<Arc<ProcessExecFn>> = OnceLock::new();

    pub fn set_process_exec(f: Arc<ProcessExecFn>) {
        let _ = PROCESS_EXEC.set(f);
    }

    pub fn get_process_exec() -> Option<&'static Arc<ProcessExecFn>> {
        PROCESS_EXEC.get()
    }
}

#[cfg(feature = "system-git")]
pub mod host_workspace {
    use std::sync::{Arc, OnceLock};

    pub type WorkspaceReadFn =
        dyn Fn(&str) -> Result<Vec<u8>, String> + Send + Sync + 'static;
    pub type WorkspaceWriteFn =
        dyn Fn(&str, &[u8]) -> Result<(), String> + Send + Sync + 'static;

    static READ: OnceLock<Arc<WorkspaceReadFn>> = OnceLock::new();
    static WRITE: OnceLock<Arc<WorkspaceWriteFn>> = OnceLock::new();

    pub fn set_read(f: Arc<WorkspaceReadFn>) {
        let _ = READ.set(f);
    }

    pub fn set_write(f: Arc<WorkspaceWriteFn>) {
        let _ = WRITE.set(f);
    }

    pub fn read(path: &str) -> Result<Vec<u8>, String> {
        let f = READ.get().ok_or_else(|| "missing host workspace.readFile".to_string())?;
        f(path)
    }

    pub fn write(path: &str, bytes: &[u8]) -> Result<(), String> {
        let f = WRITE
            .get()
            .ok_or_else(|| "missing host workspace.writeFile".to_string())?;
        f(path, bytes)
    }
}
