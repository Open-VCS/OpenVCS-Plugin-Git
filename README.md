This directory is the OpenVCS plugin bundle for Git.

- `openvcs.plugin.json` is the plugin manifest consumed by the app.
- The plugin *source* lives in `Backend/built-in-plugins/openvcs.git/src/` and builds an executable
  named `openvcs-git-plugin`.
- At runtime, OpenVCS looks for the executable in:
  - `Backend/built-in-plugins/openvcs.git/bin/openvcs-git-plugin` (packaged install), or
  - `target/{debug|release}/openvcs-git-plugin` (dev fallback).

To build the plugin executable in dev: `cargo build --bin openvcs-git-plugin`

Formatting requirement (Rust): `cargo fmt --all` (CI enforces `cargo fmt --all -- --check`).

To build the distributable plugin bundle (recommended): use the OpenVCS SDK:

```
cargo openvcs dist
```

This produces a `.ovcsp` plugin file (the packaged plugin archive) in the `dist/` directory.

Backend selection is controlled by Cargo features:
- Default: `system-git`
- Optional: `libgit2` (enable with `--features libgit2`)
