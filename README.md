# Git Plugin

This directory contains the System Git VCS backend plugin used by OpenVCS.

## Runtime model

- The plugin runs as a long-lived Node.js process.
- The plugin implements the JSON-RPC contract used by the backend runtime (`plugin.*` and `vcs.*`) through the shared SDK runtime delegates.
- The plugin can add top-level app menus and items through `@openvcs/sdk/runtime` helpers.
- The plugin can open generic plugin-owned modals with the SDK `ModalBuilder` helper.
- The Repository menu includes Git-only submodule management tooling.
- In the desktop client, the `Submodules` entry appears in `Repository` after a Git repository is open and the Git plugin runtime is active.
- Repository clone operations recurse into submodules by default.
- Repository status views tag tracked submodule paths distinctly so the client can render them as submodules.
- Git operations are executed through the local `git` CLI.
- The runtime uses a trust model (no per-capability permission prompts).

## Install

```bash
npm install
```

- The SDK dependency tracks the `edge` tag so it always follows the latest SDK commit.

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

Submodule workflow highlights:

- `clone_repo` uses `git clone --recurse-submodules`.
- Repository > Submodules supports add, sync, remove, pinned updates, and explicit remote-tracking updates.
- `Update Remote` follows the branch configured for each submodule in `.gitmodules`.

## Pack For Config Use

```bash
npm pack
```

- `npm pack` uses the package `files` list and `prepack` hook.
- OpenVCS resolves published packages and local path plugins through npm package semantics.

## Release Channels

CI publishes prereleases with these dist-tags:

- `latest`: stable releases from `Stable`
- `beta`: builds from the `Beta` branch
- `nightly`: scheduled builds from `Dev` when changes exist since the last nightly
- `edge`: working builds from `Dev` push commits

Examples:

```bash
npm install @openvcs/git-plugin@edge
npm install @openvcs/git-plugin@beta
npm install @openvcs/git-plugin@nightly
```
