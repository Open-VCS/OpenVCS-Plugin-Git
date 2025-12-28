#[cfg(feature = "system-git")]
mod system_git;

#[cfg(feature = "system-git")]
pub use system_git::GitSystem;

#[cfg(feature = "libgit2")]
mod libgit2;

#[cfg(feature = "libgit2")]
pub use libgit2::GitLibGit2;
