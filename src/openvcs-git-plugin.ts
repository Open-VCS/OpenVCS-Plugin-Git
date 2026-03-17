#!/usr/bin/env node
// Copyright © 2025-2026 OpenVCS Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { startPluginRuntime } from '@openvcs/sdk/runtime';

import { createGitPluginRuntime } from './plugin-runtime.js';

/** Starts the Git plugin runtime entrypoint. */
function main(): void {
  startPluginRuntime(createGitPluginRuntime());
}

main();
