# Git Module

This directory contains the Git backend implementation used by OpenVCS.

In the umbrella repository it may be included as a submodule. If sources are missing, run:

```bash
git submodule update --init --recursive
```

The Git backend is implemented as a plugin module that targets the `vcs` world defined in `Core/wit/vcs.wit` and is packaged as an `.ovcsp` bundle by the SDK.
