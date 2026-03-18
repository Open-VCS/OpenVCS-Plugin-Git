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
export async function OnPluginStart(): Promise<void> {
  const gitVersion = runGit(['--version'], process.cwd());
  if (gitVersion.status !== 0) {
    throw new Error('Git is not installed or not in PATH');
  }

  const versionMatch = gitVersion.stdout.match(/git version (\d+)\.(\d+)/);
  if (versionMatch) {
    const major = parseInt(versionMatch[1], 10);
    const minor = parseInt(versionMatch[2], 10);
    if (major < 2 || (major === 2 && minor < 20)) {
      throw new Error(`Git 2.20+ required, found ${versionMatch[0]}`);
    }
  }
}
