# Repository Guidelines

## Overview
This repository contains the built-in Git plugin bundle for OpenVCS (a plugin manifest plus Rust crates that implement Git backends).

## Project Structure & Module Organization
- `openvcs.plugin.json`: plugin manifest consumed by OpenVCS (declares `openvcs.git` and the `openvcs-git-plugin.wasm` module).
- `src/bin/openvcs-git-plugin.rs`: plugin module entrypoint; speaks the OpenVCS plugin protocol over stdin/stdout and selects a backend via `--backend`.
- `src/system_git.rs`: “system git” backend (shells out to `git`), compiled with the `system-git` feature (default).
- `src/libgit2/`: libgit2 backend (via the `git2` crate), compiled with the `libgit2` feature; low-level logic lives in `src/libgit2/lowlevel.rs`.

Note: these crates are typically built as part of the `OpenVCS-Client` Cargo workspace at `Backend/built-in-plugins/openvcs.git/`.

## Build, Test, and Development Commands
Run from the `OpenVCS-Client` workspace root (recommended):
- `cargo build --target wasm32-wasip1 --bin openvcs-git-plugin`: build the WASI module.
- `cargo build --target wasm32-wasip1 --bin openvcs-git-plugin --release`: release build.
- `cargo build --target wasm32-wasip1 --bin openvcs-git-plugin --features libgit2`: build with libgit2 backend compiled in.
- `cargo fmt --all`: format Rust code.
- `cargo clippy --bin openvcs-git-plugin --all-targets -- -D warnings`: lint (adjust `-D warnings` if needed).
- `cargo test`: run tests (add tests as functionality grows).

To build the distributable plugin bundle (recommended): use the OpenVCS SDK:

```
cargo openvcs dist
```

This produces a `.ovcsp` plugin file (the packaged plugin archive) in the `dist/` directory.

## Coding Style & Naming Conventions
- Rust edition is `2024`; use `rustfmt`-standard formatting (4-space indentation).
- Naming: `snake_case` for functions/vars, `PascalCase` for types, `SCREAMING_SNAKE_CASE` for constants.
- Prefer small, well-scoped modules; keep protocol/IO code in `openvcs-git-plugin` and backend logic in `system_git`/`libgit2`.

## Testing Guidelines
- Prefer unit tests in `mod tests { ... }` alongside code, and integration tests in `tests/` for end-to-end behaviors.
- When adding Git behavior tests, use temporary repositories and avoid relying on network remotes.

## Commit & Pull Request Guidelines
- Git history is minimal; use short, imperative summaries (e.g., “Fix clone progress parsing”).
- Commit message format: agents must format commit messages with a short
  title of at most 72 characters, followed by a blank line and any
  additional explanatory text in the body.
- PRs should include: what backend is affected (`git-system` vs `git-libgit2`), reproduction steps, and any platform assumptions (SSH/auth, filesystem paths).

- Before committing changes, run `just fix` to auto-apply formatting and lint fixes.
- Commit edits locally using a clear, conventional commit message, but do NOT push changes to any remote; leave push/PR creation to a human maintainer.

**Sandbox note**: Running `just fix` and some `cargo` commands (for example `cargo build`, `cargo test`, or commands that fetch dependencies or build native binaries) may require network access or host-level tooling and therefore should be run outside a restricted sandbox or container. If you are operating with sandboxing or restricted network access, request approval before executing these commands or run them on the host machine.

## Security & Configuration Tips
- Avoid logging secrets; this plugin exchanges JSON messages over stdio.
- SSH behavior may be influenced by `OPENVCS_SSH_MODE` / `OPENVCS_SSH` (see `src/system_git.rs`).
