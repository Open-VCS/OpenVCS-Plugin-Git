# Git Plugin Architecture

This document describes the Git backend implementation in `Git/`.

## Responsibility

The plugin implements the backend JSON-RPC contract (`plugin.*` and `vcs.*`)
and exposes a single VCS backend id: `git`.

## Command execution

- Git operations run directly through the local `git` CLI.
- The runtime uses a trust model (no per-capability prompts).
- The plugin currently uses System Git only.
- Status reads use `git status --porcelain=1 --branch -z` so file paths are
  NUL-delimited and not C-quoted.

## State

The plugin stores lightweight runtime state:

- active session map (`session_id -> workdir`)

## Manifest

`openvcs.plugin.json` declares:

- `module.exec`: `openvcs-git-plugin.mjs`
- `module.vcs_backends`: `git`

## Packaging

The SDK packages this plugin into an `.ovcsp` bundle with:

```text
openvcs.git/
  openvcs.plugin.json
  bin/openvcs-git-plugin.mjs
```
