// Copyright © 2025-2026 OpenVCS Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { getOrCreateMenu, registerAction, ModalBuilder } from '@openvcs/sdk/runtime';

import { GitCommand, type SubmoduleEntry } from './git.js';

type ModalActionPayload = Record<string, unknown>;

/** Returns a Git command bound to the current process working directory. */
function createGitCommand(): GitCommand {
  return new GitCommand(process.cwd());
}

/** Coerces an unknown action payload into a plain record. */
function asPayload(value: unknown): ModalActionPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as ModalActionPayload;
}

/** Returns one trimmed string field from an action payload. */
function payloadString(payload: ModalActionPayload, key: string): string {
  return String(payload[key] ?? '').trim();
}

/** Builds one modal row for a submodule entry. */
function buildSubmoduleRow(entry: SubmoduleEntry) {
  const metaBits = [entry.commit ? `commit ${entry.commit}` : '', entry.branch ? `branch ${entry.branch}` : '']
    .map((part) => String(part || '').trim())
    .filter(Boolean);

  const description = [entry.url, metaBits.join(' · ')]
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join(' · ');

  return {
    id: entry.path,
    title: entry.path,
    status: entry.state,
    meta: entry.name,
    description,
    actions: [
      { type: 'button' as const, id: 'submodules-update', content: 'Update', payload: { path: entry.path } },
      { type: 'button' as const, id: 'submodules-sync', content: 'Sync', payload: { path: entry.path } },
      {
        type: 'button' as const,
        id: 'submodules-remove-request',
        content: 'Remove',
        variant: 'danger' as const,
        payload: { path: entry.path, name: entry.name },
      },
    ],
  };
}

/** Builds and opens the submodule manager modal. */
async function openSubmodulesModal(): Promise<void> {
  const git = createGitCommand();
  const entries = git.listSubmodules();

  const modal = new ModalBuilder('Manage Submodules')
    .text('Review, add, update, sync, and remove submodules without leaving Git.')
    .separator()
    .input('url', 'Submodule URL', {
      kind: 'url',
      placeholder: 'https://example.com/repo.git',
    })
    .input('path', 'Submodule Path', {
      placeholder: 'libs/example',
    })
    .input('name', 'Submodule Name', {
      placeholder: 'example',
    })
    .input('branch', 'Branch (optional)', {
      placeholder: 'main',
    })
    .button('submodules-add', 'Add Submodule', {
      variant: 'primary',
      align: 'centered',
    })
    .button('repo-submodules', 'Refresh', {
      align: 'centered',
    })
    .button('submodules-update-all', 'Update All (Recursive)', {
      align: 'centered',
    })
    .button('submodules-sync-all', 'Sync All', {
      align: 'centered',
    })
    .separator()
    .list('submodules', {
      label: 'Submodules',
      emptyText: 'This repository has no submodules yet.',
      items: entries.map((entry) => buildSubmoduleRow(entry)),
    });

  await modal.open();
}

/** Builds and opens the remove confirmation modal for one submodule. */
async function openRemoveConfirmationModal(path: string, name?: string): Promise<void> {
  const submodulePath = String(path || '').trim();
  if (!submodulePath) return;

  const modal = new ModalBuilder('Confirm Submodule Removal')
    .text(`Remove the submodule at ${submodulePath}? This will deinitialize the submodule, remove it from the index, and delete its working tree entry.`)
    .button('repo-submodules', 'Back', {
      align: 'centered',
    })
    .button('submodules-remove-confirm', 'Remove Submodule', {
      variant: 'danger',
      align: 'centered',
      payload: { path: submodulePath, name: String(name || '').trim() || undefined },
    });

  await modal.open();
}

/** Removes one submodule and refreshes the toolkit modal. */
async function removeSubmodule(payload: ModalActionPayload): Promise<void> {
  const path = payloadString(payload, 'path');
  if (!path) return;
  const git = createGitCommand();
  git.removeSubmodule(path);
  await openSubmodulesModal();
}

/** Adds one submodule and refreshes the toolkit modal. */
async function addSubmodule(payload: ModalActionPayload): Promise<void> {
  const url = payloadString(payload, 'url');
  const path = payloadString(payload, 'path');
  const name = payloadString(payload, 'name');
  const branch = payloadString(payload, 'branch');

  if (!url || !path) {
    throw new Error('Submodule URL and path are required');
  }

  const git = createGitCommand();
  git.addSubmodule(url, path, name || undefined, branch || undefined);
  await openSubmodulesModal();
}

/** Updates one submodule and refreshes the toolkit modal. */
async function updateSubmodule(payload: ModalActionPayload): Promise<void> {
  const path = payloadString(payload, 'path');
  if (!path) return;
  const git = createGitCommand();
  git.updateSubmodule(path);
  await openSubmodulesModal();
}

/** Syncs one submodule and refreshes the toolkit modal. */
async function syncSubmodule(payload: ModalActionPayload): Promise<void> {
  const path = payloadString(payload, 'path');
  if (!path) return;
  const git = createGitCommand();
  git.syncSubmodule(path);
  await openSubmodulesModal();
}

/** Updates all submodules recursively and refreshes the toolkit modal. */
async function updateAllSubmodules(): Promise<void> {
  const git = createGitCommand();
  git.updateAllSubmodules();
  await openSubmodulesModal();
}

/** Syncs all submodules recursively and refreshes the toolkit modal. */
async function syncAllSubmodules(): Promise<void> {
  const git = createGitCommand();
  git.syncAllSubmodules();
  await openSubmodulesModal();
}

/** Registers the Git submodule toolkit menu and action handlers. */
export function registerSubmoduleToolkit(): void {
  const repoMenu = getOrCreateMenu('repository', 'Repository');
  repoMenu?.addItem({ label: 'Submodules', action: 'repo-submodules' });

  registerAction('repo-submodules', async () => {
    await openSubmodulesModal();
  });

  registerAction('submodules-add', async (payload?: unknown) => {
    await addSubmodule(asPayload(payload));
  });

  registerAction('submodules-update-all', async () => {
    await updateAllSubmodules();
  });

  registerAction('submodules-sync-all', async () => {
    await syncAllSubmodules();
  });

  registerAction('submodules-update', async (payload?: unknown) => {
    await updateSubmodule(asPayload(payload));
  });

  registerAction('submodules-sync', async (payload?: unknown) => {
    await syncSubmodule(asPayload(payload));
  });

  registerAction('submodules-remove-request', async (payload?: unknown) => {
    const data = asPayload(payload);
    await openRemoveConfirmationModal(payloadString(data, 'path'), payloadString(data, 'name'));
  });

  registerAction('submodules-remove-confirm', async (payload?: unknown) => {
    await removeSubmodule(asPayload(payload));
  });
}
