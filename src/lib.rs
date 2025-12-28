#[cfg(feature = "system-git")]
#[path = "openvcs-git/src/lib.rs"]
mod git_system;

#[cfg(feature = "system-git")]
pub use git_system::GitSystem;

#[cfg(feature = "libgit2")]
#[path = "openvcs-git-libgit2/src/lib.rs"]
mod git_libgit2;

#[cfg(feature = "libgit2")]
pub use git_libgit2::GitLibGit2;

