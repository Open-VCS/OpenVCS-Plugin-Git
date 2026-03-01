# Git Plugin

This directory contains the System Git VCS backend plugin used by OpenVCS.

## Runtime model

- The plugin runs as a long-lived Node.js process.
- The plugin implements the JSON-RPC contract used by the backend runtime (`plugin.*` and `vcs.*`).
- Git operations are executed through the local `git` CLI.
- The runtime uses a trust model (no per-capability permission prompts).

## Build

```bash
cd Git
npm install
npm run build
```

## Test

```bash
cd Git
npm test
```

## Package

```bash
cargo openvcs dist --plugin-dir /projects/OpenVCS/Git --out /path/to/dist
```
