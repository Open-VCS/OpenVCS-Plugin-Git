# Git Plugin Architecture

This document describes the Git backend implementation in `Git/`.

## Responsibility

The plugin implements the backend JSON-RPC contract (`plugin.*` and `vcs.*`)
through `@openvcs/sdk/runtime` delegates and exposes a single VCS backend id:
`git`.

## Command execution

- Git operations run directly through the local `git` CLI.
- The runtime uses a trust model (no per-capability prompts).
- The plugin currently uses System Git only.
- TypeScript source lives under `src/` and compiles into the packaged `bin/`
  runtime files.
- Shared transport, JSON-RPC framing, host notifications, and exact-method
  delegate dispatch now live in `SDK/`; this module keeps only Git session
  state, git subprocess execution, parsers, and Git-specific `vcs.*` handlers.
- `src/plugin-request-handler.ts` now exports `GitVcsDelegates`, a
  `VcsDelegateBase` subclass whose ordinary camelCase methods are mapped to the
  exact `vcs.*` JSON-RPC method names consumed by the runtime.
- Status reads use `git status --porcelain=1 --branch -z -uall` so file paths are
  NUL-delimited and not C-quoted.
- After porcelain parsing, the plugin cross-references `.gitmodules` paths so
  tracked submodule entries are surfaced with a dedicated submodule status marker
  for the client UI.
- For rename and copy records, the porcelain format includes two NUL-terminated
  paths: the original/source path first, then the new/destination path. The
  plugin assigns `path` to the new path and `old_path` to the original path.
- Network commands (`fetch`, `push`, `pull`) omit optional arguments (remote,
  refspec, branch) when not provided, allowing Git to use its defaults instead
  of receiving empty string arguments.
- Clone uses `git clone --recurse-submodules` so repositories arrive with
  submodules initialized by default.
- The Repository menu submodule toolkit keeps pinned `git submodule update`
  behavior separate from explicit `--remote` updates that follow the configured
  branch in `.gitmodules`.

## State

The plugin stores lightweight runtime state:

- active session map (`session_id -> workdir`)

## Manifest

`package.json.openvcs` declares:

- `module.exec`: `openvcs-git-plugin.js`
- `module.vcs_backends`: `git`
- `bin/plugin.js`: compiled author module exporting `OnPluginStart()`

## Packaging

This plugin is published and consumed as an npm package with these runtime files:

```text
openvcs.git/
  package.json
  bin/openvcs-git-plugin.js  (SDK-generated bootstrap, entry point)
  bin/plugin.js              (authored module with PluginDefinition + OnPluginStart)
  bin/plugin-helpers.js
  bin/plugin-request-handler.js
  bin/plugin-runtime.js
```

`openvcs build` now generates `bin/openvcs-git-plugin.js` as the SDK-owned
bootstrap (referenced by `module.exec` in the manifest). The authored Git module
lives in `src/plugin.ts` and compiles to `bin/plugin.js`, where `PluginDefinition`
declares runtime options up front and `OnPluginStart()` validates Git, constructs
`GitVcsDelegates`, and assigns `PluginDefinition.vcs = delegates.toDelegates()`
before the SDK runtime starts processing requests.
