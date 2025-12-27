This directory is the OpenVCS plugin bundle for Git.

- `openvcs.plugin.json` is the plugin manifest consumed by the app.
- The plugin *source* lives in `Backend/built-in-plugins/openvcs.git/src/` and builds an executable
  named `openvcs-git-plugin`.
- At runtime, OpenVCS looks for the executable in:
  - `Backend/built-in-plugins/openvcs.git/bin/openvcs-git-plugin` (packaged install), or
  - `target/{debug|release}/openvcs-git-plugin` (dev fallback).

To build the plugin executable in dev: `cargo build -p openvcs-git-plugin`
