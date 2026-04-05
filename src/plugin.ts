// Copyright © 2025-2026 OpenVCS Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import type { PluginModuleDefinition } from '@openvcs/sdk/runtime';

import {
  GitVcsDelegates,
  type GitRuntimeDependencies,
} from './plugin-request-handler.js';

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

/** Returns the runtime services passed to the Git VCS delegate class. */
function createGitRuntimeDependencies(): GitRuntimeDependencies {
  return {
    allocateSession,
    closeSession,
    requireSession,
    createGitCommand,
  };
}

/** Builds the repository menu contributed by the Git plugin. */
function createRepositoryMenu() {
  return {
    id: 'repository',
    label: 'Repository',
    elements: [
      { type: 'button', id: 'repo-edit-gitignore', label: 'Edit .gitignore' },
      { type: 'button', id: 'repo-edit-gitattributes', label: 'Edit .gitattributes' },
    ],
  };
}

/** Registers the Git plugin with the OpenVCS SDK runtime.
 * 
 * Provides Git runtime options up front and defers `vcs.*` delegate registration
 * until `OnPluginStart()` validates the local Git installation. */
export const PluginDefinition: PluginModuleDefinition = {
  logTarget: 'openvcs.git.plugin',
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

  const delegates = new GitVcsDelegates(createGitRuntimeDependencies());
  PluginDefinition.vcs = delegates.toDelegates();

  PluginDefinition.plugin = {
    async 'plugin.get_menus'() {
      return [createRepositoryMenu()];
    },
  };
}
