# Git Plugin

This directory contains the System Git VCS backend plugin used by OpenVCS.

## Runtime model

- The plugin runs as a long-lived Node.js process.
- The plugin implements the JSON-RPC contract used by the backend runtime (`plugin.*` and `vcs.*`) through the shared SDK runtime delegates.
- The plugin can add top-level app menus and items through `@openvcs/sdk/runtime` helpers.
- The plugin can open generic plugin-owned modals with the SDK `ModalBuilder` helper.
- The Repository menu includes Git-only submodule management tooling.
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

## Pack For Config Use

```bash
npm pack
```

- `npm pack` uses the package `files` list and `prepack` hook.
- OpenVCS resolves published packages and local path plugins through npm package semantics.
