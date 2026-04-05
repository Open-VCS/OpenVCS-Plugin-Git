# Git Plugin

This directory contains the System Git VCS backend plugin used by OpenVCS.

## Runtime model

- The plugin runs as a long-lived Node.js process.
- The plugin implements the JSON-RPC contract used by the backend runtime (`plugin.*` and `vcs.*`) through the shared SDK runtime delegates.
- The plugin contributes top-level menu items by returning `plugin.get_menus` payloads through the SDK runtime.
- Git operations are executed through the local `git` CLI.
- The runtime uses a trust model (no per-capability permission prompts).

## Install

```bash
npm install
```

- The SDK dependency is pinned to the `^0.2` range so it tracks the latest `0.2.x` releases.

## Validate

```bash
npm run lint
```

## Build

```bash
npm run build
```

- TypeScript sources live in `src/`.
- `npm run build` runs `openvcs build`, which invokes `build:plugin` and writes the runtime into `bin/`.

## Test

```bash
npm test
```

## Package

```bash
npm run dist
```

- `npm run dist` runs `openvcs dist`, which builds plugin assets before packaging unless `--no-build` is passed.
