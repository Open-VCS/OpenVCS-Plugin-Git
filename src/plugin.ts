// Copyright © 2025-2026 OpenVCS Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import type { PluginModuleDefinition } from '@openvcs/sdk/runtime';

import { createGitVcsDelegates } from './plugin-request-handler.js';

import {
  allocateSession,
  closeSession,
  requireSession,
  runGit,
  runGitChecked,
} from './plugin-runtime.js';

/** Registers the Git plugin handlers before the SDK runtime starts. */
export const PluginDefinition: PluginModuleDefinition = {
  logTarget: 'openvcs.git.plugin',
  vcs: createGitVcsDelegates({
    allocateSession,
    closeSession,
    requireSession,
    runGit,
    runGitChecked,
  }),
};

/** Runs Git plugin startup work before the generated runtime begins processing requests. */
export function OnPluginStart(): void {}
