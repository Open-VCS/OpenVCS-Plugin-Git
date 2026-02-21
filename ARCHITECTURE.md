# Git Plugin Architecture

This document describes the Git backend implementation in `Git/`.

## Responsibility

The plugin implements `Core/wit/vcs.wit` (`world vcs`) and exposes a single VCS
backend id: `git`.

## Command execution

- Git operations run through the host import `host-api.process-exec`.
- The host keeps process execution sandboxed using capability checks and workspace
  path confinement.
- The plugin currently uses System Git only.

## State

The plugin stores lightweight runtime state:

- active workdir path
- parsed host git settings from `vcs.open(path, config)`

## Manifest and capabilities

`openvcs.plugin.json` declares:

- `module.exec`: `openvcs-git-plugin.wasm`
- `module.vcs_backends`: `git`
- `capabilities`: `process.exec`, `workspace.write`

## Packaging

The SDK packages this plugin into an `.ovcsp` bundle with:

```text
openvcs.git/
  openvcs.plugin.json
  bin/openvcs-git-plugin.wasm
```
