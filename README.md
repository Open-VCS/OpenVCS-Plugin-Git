# Git Plugin

This directory contains the System Git VCS backend plugin used by OpenVCS.

## Runtime model

- The plugin implements `Core/wit/vcs.wit` (`world vcs`).
- The plugin uses `openvcs-core` generated VCS bindings/macros (no direct `wit-bindgen` dependency).
- Git operations are executed through the host `process-exec` API.
- The plugin requests these permissions in `openvcs.plugin.json`:
  - `process.exec`
  - `workspace.write`

## Settings

The plugin receives host settings bytes in `vcs.open(path, config)` and reads the
`git` section for behavior such as default fetch pruning and hook policy.

## Build

```bash
cd Git
cargo build --release --target wasm32-wasip1
```

## Test

```bash
cd Git
cargo test
```

## Package

```bash
cargo openvcs dist --plugin-dir /projects/OpenVCS/Git --out /path/to/dist
```
