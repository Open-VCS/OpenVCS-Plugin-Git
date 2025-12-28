#[cfg(feature = "system-git")]
mod system_git;

#[cfg(feature = "system-git")]
pub use system_git::GitSystem;

#[cfg(feature = "libgit2")]
mod libgit2;

#[cfg(feature = "libgit2")]
pub use libgit2::GitLibGit2;

#[cfg(feature = "system-git")]
pub mod host_exec {
    use std::path::Path;
    use std::sync::{Arc, OnceLock};

    #[derive(Debug, Clone)]
    pub struct HostExecOutput {
        pub success: bool,
        pub status: i32,
        pub stdout: String,
        pub stderr: String,
    }

    pub type HostExecFn = dyn Fn(
            Option<&Path>,
            &[String],
            &[(String, String)],
            Option<&str>,
        ) -> Result<HostExecOutput, String>
        + Send
        + Sync
        + 'static;

    static HOST_EXEC: OnceLock<Arc<HostExecFn>> = OnceLock::new();

    pub fn set_host_exec(f: Arc<HostExecFn>) {
        let _ = HOST_EXEC.set(f);
    }

    pub fn get_host_exec() -> Option<&'static Arc<HostExecFn>> {
        HOST_EXEC.get()
    }
}
