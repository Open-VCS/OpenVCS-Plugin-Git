// Copyright © 2025-2026 OpenVCS Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import type { PluginModuleDefinition } from '@openvcs/sdk/runtime';

import { createGitVcsDelegates } from './plugin-request-handler.js';

import {
  allocateSession,
  closeSession,
  requireSession,
} from './plugin-runtime.js';

import { GitCommand } from './git.js';

/** Creates a GitCommand instance for a given repository path. */
function createGitCommand(cwd: string): GitCommand {
  return new GitCommand(cwd);
}

/** Registers the Git plugin handlers before the SDK runtime starts. */
export const PluginDefinition: PluginModuleDefinition = {
  logTarget: 'openvcs.git.plugin',
  vcs: createGitVcsDelegates({
    allocateSession,
    closeSession,
    requireSession,
    createGitCommand,
  }),
};

/** Runs Git plugin startup work before the generated runtime begins processing requests. */
export async function OnPluginStart(): Promise<void> {
  const git = new GitCommand(process.cwd());
  const { major, minor } = git.version();

  if (major < 2 || (major === 2 && minor < 20)) {
    throw new Error(`Git 2.20+ required, found ${major}.${minor}`);
  }
}
