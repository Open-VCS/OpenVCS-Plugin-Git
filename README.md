This directory contains the built-in Git plugin bundle for OpenVCS: the plugin
manifest plus the Rust crates and executable that implement Git backends.

**Quick Links**
- Plugin manifest: `openvcs.plugin.json`:1
- Plugin executable crate: `src/openvcs-git-plugin/`:1
- System-git backend: `src/openvcs-git/`:1
- libgit2 backend (optional): `src/openvcs-git-libgit2/`:1

**Purpose**
- Provide an `openvcs-git-plugin` executable that implements the OpenVCS
  plugin protocol over `stdin`/`stdout` and exposes Git-backed repository
  operations to the OpenVCS host.

**Prerequisites**
- Rust toolchain (recommended via `rustup`) targeting the repository's
  Rust edition.
- If you enable the `libgit2` backend, you may need the system `libgit2`
  library and headers installed (platform-specific).

**Build (development)**
- Build the plugin binary: `cargo build --bin openvcs-git-plugin`
- Build with the `libgit2` backend: `cargo build --bin openvcs-git-plugin --features libgit2`
- Release build: `cargo build --bin openvcs-git-plugin --release`

At runtime OpenVCS locates the plugin executable in either:
- Packaged install: `Backend/built-in-plugins/openvcs.git/bin/openvcs-git-plugin`:1
- Development fallback: `target/{debug|release}/openvcs-git-plugin`:1

**Build (distribution)**
- Use the OpenVCS SDK to create a distributable plugin archive:
  `cargo openvcs dist`
- The command produces a `.ovcsp` file in the `dist/` directory.

**Backend Selection**
- Default backend (compiled by default): `system-git` (shells out to the
  system `git` executable).
- Optional backend: `libgit2` (enable with `--features libgit2`, uses the
  `git2` crate). Choose the backend at compile time via Cargo features.

**Formatting, Linting & Tests**
- Format: `cargo fmt --all` (CI enforces `cargo fmt --all -- --check`).
- Lint: `cargo clippy --bin openvcs-git-plugin --all-targets -- -D warnings`.
- Convenience: if you have `just` installed, run `just fix` to apply
  formatting and minor lint fixes (see `Justfile`).
- Tests: `cargo test` (add tests alongside code following the project's
  testing guidelines).

**Development Notes**
- Keep protocol/IO code in `src/openvcs-git-plugin/` and backend logic in the
  backend crates (`src/openvcs-git/` and `src/openvcs-git-libgit2/`).
- For libgit2, low-level logic lives in
  `src/openvcs-git-libgit2/src/lowlevel.rs`:1
- Avoid logging secrets — the plugin exchanges JSON messages over stdio.

**Contributing**
- Commit message format: short imperative title (<=72 chars), blank line,
  then optional body. Example: `Fix clone progress parsing`.
- Before committing run `just fix` to auto-format and lint fixes.

**License**
- See `LICENSE`:1 for licensing information.

If you'd like, I can also:
- add a short example showing how OpenVCS invokes the plugin, or
- add a CONTRIBUTING section with a developer checklist.
