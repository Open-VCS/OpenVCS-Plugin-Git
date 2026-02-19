# Git Architecture

This document describes the Git backend module in `Git/`.

## Status

In this umbrella repository, `Git/` is typically managed as a separate implementation that may be included as a submodule.
If this directory is empty or missing expected sources, initialize submodules:

```bash
git submodule update --init --recursive
```

## Responsibility

The Git module provides a plugin module that implements the `vcs` world contract from `Core/wit/vcs.wit`.
It is packaged into an `.ovcsp` bundle by the SDK and installed/loaded by the client backend.
