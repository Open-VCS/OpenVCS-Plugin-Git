# Git Plugin Guidelines

## Overview
`Git/` is the system Git VCS plugin package. It runs as a long-lived Node.js process, uses the shared SDK runtime, and ships runtime output in `bin/`.

## Structure
- `src/` — TypeScript source for the plugin, runtime glue, Git helpers, and submodule workflows.
- `test/` — Node test files for plugin and submodule behavior.
- `bin/` — generated runtime bundle; do not edit manually.

## Where to look
| Task | Location | Notes |
|---|---|---|
| Plugin startup or menu wiring | `src/plugin.ts` | Entry point for the plugin definition. |
| Runtime/host plumbing | `src/plugin-runtime.ts`, `src/plugin-request-handler.ts` | JSON-RPC and Node process integration. |
| Git command handling | `src/git.ts` | Local CLI execution and result parsing. |
| Submodule logic | `src/submodules.ts` | Add/sync/remove/update flows. |
| Behavior tests | `test/*.test.ts` | Keep scenarios close to the code. |

## Conventions
- Keep the plugin contract aligned with `Client/Backend/src/plugin_runtime/protocol.rs` and `SDK/` runtime/types.
- Keep `src/` as the source of truth; generated `bin/` files follow from `npm run build`.
- Favor explicit Git CLI calls and keep submodule handling deterministic.

## Anti-patterns
- Editing generated files under `bin/`.
- Changing host-facing labels, actions, or JSON-RPC method names without coordinating the client and SDK.
- Mixing template/plugin scaffolding concerns into Git-specific runtime code.

## Commands
```bash
npm install
npm run lint
npm test
npm run build
npm pack
```

## Notes
- This package has its own release channels and packaging metadata; keep README and `package.json` consistent.
- Submodule behavior is user-visible in the desktop client, so doc updates belong with behavior changes.
