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

/** Registers the Git plugin with the OpenVCS SDK runtime.
 * 
 * Provides VCS capabilities (branches, commits, status, etc.) for Git repositories.
 * The plugin delegates are created with session management and Git command execution. */
export const PluginDefinition: PluginModuleDefinition = {
  logTarget: 'openvcs.git.plugin',
  vcs: createGitVcsDelegates({
    allocateSession,
    closeSession,
    requireSession,
    createGitCommand,
  }),
};

/** Validates Git installation and version at plugin startup.
 * 
 * Runs before the runtime begins processing requests. Throws if Git is not
 * installed or version is below 2.20.
 * @throws Error if Git is not available or version is unsupported */
export function OnPluginStart(): void {
  const git = new GitCommand(process.cwd());
  const { major, minor } = git.version();

  if (major < 2 || (major === 2 && minor < 20)) {
    throw new Error(`Git 2.20+ required, found ${major}.${minor}`);
  }
}
