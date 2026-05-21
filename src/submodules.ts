// Copyright © 2025-2026 OpenVCS Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { getOrCreateMenu, registerAction, ModalBuilder } from '@openvcs/sdk/runtime';

import { GitCommand, type SubmoduleEntry } from './git.js';

type ModalActionPayload = Record<string, unknown>;

/** Returns a Git command bound to the current process working directory. */
/* c8 ignore next 3 */
function createGitCommand(): GitCommand {
  return new GitCommand(process.cwd());
}

/** Coerces an unknown action payload into a plain record. Exported for testing. */
export function asPayload(value: unknown): ModalActionPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as ModalActionPayload;
}

/** Returns one trimmed string field from an action payload. Exported for testing. */
export function payloadString(payload: ModalActionPayload, key: string): string {
  return String(payload[key] ?? '').trim();
}

/** Builds one modal row for a submodule entry. */
export function buildSubmoduleRow(entry: SubmoduleEntry) {
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
      {
        type: 'button' as const,
        id: 'submodules-update-remote',
        content: 'Update Remote',
        payload: { path: entry.path },
      },
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

/** Builds an error fallback modal with a descriptive message. */
/* c8 ignore next 3 */
function buildErrorModal(message: string): ModalBuilder {
  return new ModalBuilder('Error').text(message).text('Please try again or check the Git repository state.');
}

/** Opens a fallback modal for a submodule UI failure and preserves the original error on fallback failure. */
export async function handleSubmoduleModalError(
  prefix: string,
  error: unknown,
  openFallback: (message: string) => Promise<unknown> = (message) => buildErrorModal(message).open(),
): Promise<unknown> {
  const message = error instanceof Error ? error.message : String(error);
  const fullMessage = `${prefix}: ${message}`;
  console.error(`Git submodules: ${fullMessage}`);

  try {
    return await openFallback(fullMessage);
  } catch {
    throw error;
  }
}

/* c8 ignore start */
/** Builds and opens the submodule manager modal. */
async function openSubmodulesModal(): Promise<unknown> {
  const git = createGitCommand();

  let entries: SubmoduleEntry[];
  try {
    entries = git.listSubmodules();
  } catch (error) {
    return handleSubmoduleModalError('failed to list submodules', error);
  }

  console.log('Git submodules: building modal', { count: entries.length });

  const modal = buildSubmodulesModal(entries);
  try {
    return await modal.open();
  } catch (error) {
    return handleSubmoduleModalError('failed to open modal', error);
  }
}

/** Builds the submodule manager modal with given entries. */
function buildSubmodulesModal(entries: SubmoduleEntry[]): ModalBuilder {
  return new ModalBuilder('Manage Submodules')
    .text('Review, add, update, sync, and remove submodules without leaving Git.')
    .text('Use Update Remote to follow each submodule branch configured in .gitmodules.')
    .separator()
    .verticalBox(
      [
        {
          type: 'input' as const,
          id: 'url',
          label: 'Submodule URL',
          kind: 'url' as const,
          placeholder: 'https://example.com/repo.git',
        },
        {
          type: 'grid' as const,
          columns: 'minmax(0, 1fr) minmax(0, 1fr)',
          gap: '.75rem',
          content: [
            {
              type: 'input' as const,
              id: 'path',
              label: 'Submodule Path',
              placeholder: 'libs/example',
            },
            {
              type: 'input' as const,
              id: 'name',
              label: 'Submodule Name',
              placeholder: 'example',
            },
          ],
        },
        {
          type: 'input' as const,
          id: 'branch',
          label: 'Branch (optional)',
          placeholder: 'main',
        },
      ],
      { gap: '1rem' },
    )
    .horizontalBox(
      [
        { type: 'button' as const, id: 'submodules-add', content: 'Add Submodule', variant: 'primary' as const },
        { type: 'button' as const, id: 'repo-submodules', content: 'Refresh' },
      ],
      { gap: '.5rem', align: 'centered', wrap: true },
    )
    .horizontalBox(
      [
        { type: 'button' as const, id: 'submodules-update-all', content: 'Update All (Recursive)' },
        { type: 'button' as const, id: 'submodules-update-all-remote', content: 'Update All From Branches' },
        { type: 'button' as const, id: 'submodules-sync-all', content: 'Sync All' },
      ],
      { gap: '.5rem', align: 'centered', wrap: true },
    )
    .separator()
    .list('submodules', {
      label: 'Submodules',
      emptyText: 'This repository has no submodules yet.',
      items: entries.map((entry) => buildSubmoduleRow(entry)),
    });
}

/** Builds and opens the remove confirmation modal for one submodule. */
async function openRemoveConfirmationModal(path: string, name?: string): Promise<unknown> {
  const submodulePath = String(path || '').trim();
  if (!submodulePath) return;

  console.log('Git submodules: building remove confirmation', { path: submodulePath, name });

  const modal = new ModalBuilder('Confirm Submodule Removal')
    .text(`Remove the submodule at ${submodulePath}? This will deinitialize the submodule, remove it from the index, and delete its working tree entry.`)
    .horizontalBox(
      [
        { type: 'button' as const, id: 'repo-submodules', content: 'Back' },
        {
          type: 'button' as const,
          id: 'submodules-remove-confirm',
          content: 'Remove Submodule',
          variant: 'danger' as const,
          payload: { path: submodulePath, name: String(name || '').trim() || undefined },
        },
      ],
      { gap: '.5rem', align: 'centered', wrap: true },
    );

  try {
    return await modal.open();
  } catch (error) {
    return handleSubmoduleModalError('failed to open remove confirmation modal', error);
  }
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

/** Updates one submodule from its configured branch and refreshes the toolkit modal. */
async function updateSubmoduleRemote(payload: ModalActionPayload): Promise<void> {
  const path = payloadString(payload, 'path');
  if (!path) return;
  const git = createGitCommand();
  git.updateSubmoduleRemote(path);
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

/** Updates all submodules from their configured branches and refreshes the toolkit modal. */
async function updateAllSubmodulesRemote(): Promise<void> {
  const git = createGitCommand();
  git.updateAllSubmodulesRemote();
  await openSubmodulesModal();
}

/** Syncs all submodules recursively and refreshes the toolkit modal. */
async function syncAllSubmodules(): Promise<void> {
  const git = createGitCommand();
  git.syncAllSubmodules();
  await openSubmodulesModal();
}

/* c8 ignore stop */

/** Registers the Git submodule toolkit menu and action handlers. */
export function registerSubmoduleToolkit(): void {
  const repoMenu = getOrCreateMenu('repository', 'Repository', { surface: 'menubar' });
  repoMenu?.addItem({ label: 'Submodules', action: 'repo-submodules' });

  /* c8 ignore next 3 */
  registerAction('repo-submodules', async () => {
    console.log('Git submodules: repo-submodules action invoked');
    return openSubmodulesModal();
  });
  /* c8 ignore next 3 */
  registerAction('submodules-add', async (payload?: unknown) => {
    return addSubmodule(asPayload(payload));
  });
  /* c8 ignore next 3 */
  registerAction('submodules-update-all', async () => {
    return updateAllSubmodules();
  });
  /* c8 ignore next 3 */
  registerAction('submodules-update-all-remote', async () => {
    return updateAllSubmodulesRemote();
  });
  /* c8 ignore next 3 */
  registerAction('submodules-sync-all', async () => {
    return syncAllSubmodules();
  });
  /* c8 ignore next 3 */
  registerAction('submodules-update', async (payload?: unknown) => {
    return updateSubmodule(asPayload(payload));
  });
  /* c8 ignore next 3 */
  registerAction('submodules-update-remote', async (payload?: unknown) => {
    return updateSubmoduleRemote(asPayload(payload));
  });
  /* c8 ignore next 3 */
  registerAction('submodules-sync', async (payload?: unknown) => {
    return syncSubmodule(asPayload(payload));
  });
  /* c8 ignore next 3 */
  registerAction('submodules-remove-request', async (payload?: unknown) => {
    const data = asPayload(payload);
    return openRemoveConfirmationModal(payloadString(data, 'path'), payloadString(data, 'name'));
  });
  /* c8 ignore next 3 */
  registerAction('submodules-remove-confirm', async (payload?: unknown) => {
    return removeSubmodule(asPayload(payload));
  });
}
