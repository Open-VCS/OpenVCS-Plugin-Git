// OpenVCS Git plugin UI entry.
//
// This version is sandbox-runtime compatible:
// - no direct host DOM access
// - all host/backend interaction goes through OpenVCS bridge APIs

const GitSettingsHtml = `
<form class="panel-form" data-panel="git">
  <div class="group">
    <label for="set-git-backend">Git Backend
      <span class="help-tip" title="Choose Git implementation. System uses your installed git; Libgit2 uses embedded library.">?</span>
    </label>
    <select id="set-git-backend">
      <option value="" disabled selected>Loading…</option>
    </select>
  </div>

  <div class="group">
    <label for="set-merge-message-template">Merge commit message template
      <span class="help-tip" title="Leave blank to use Git's default merge message. Placeholders: {branch:source}, {branch:target}, {repo:name}, {repo:username}.">?</span>
    </label>
    <input id="set-merge-message-template" type="text" placeholder="Merged branch '{branch:source}' into '{branch:target}'" />
  </div>

  <div class="group">
    <label for="set-git-ssh-binary">SSH binary (System backend)
      <span class="help-tip" title="Controls which ssh executable Git uses for SSH remotes. Auto prefers the host OpenSSH on Linux (helps AppImage + crypto-policies).">?</span>
    </label>
    <select id="set-git-ssh-binary">
      <option value="auto">Auto</option>
      <option value="host">Host</option>
      <option value="bundled">Bundled/In-PATH</option>
      <option value="custom">Custom path</option>
    </select>
  </div>

  <div class="group">
    <label for="set-git-ssh-path">Custom SSH path
      <span class="help-tip" title="Used only when SSH binary is set to Custom path (e.g. /usr/bin/ssh).">?</span>
    </label>
    <input id="set-git-ssh-path" type="text" placeholder="/usr/bin/ssh" />
  </div>

  <div class="group">
    <label class="checkbox"><input type="checkbox" id="set-prune-on-fetch" /> Prune on fetch
      <span class="help-tip" title="Remove remote-tracking branches that no longer exist on the server.">?</span>
    </label>
  </div>

  <div class="group">
    <label class="checkbox"><input type="checkbox" id="set-fetch-on-focus" /> Fetch on app focus
      <span class="help-tip" title="Automatically runs git fetch when the app regains focus.">?</span>
    </label>
  </div>

  <div class="group">
    <label for="set-hook-policy">Hooks
      <span class="help-tip" title="Control whether project Git hooks are allowed to run.">?</span>
    </label>
    <select id="set-hook-policy" disabled>
      <option value="deny">Deny</option>
      <option value="ask">Ask</option>
      <option value="allow">Allow</option>
    </select>
  </div>

  <div class="group">
    <label class="checkbox"><input type="checkbox" id="set-respect-autocrlf" disabled /> Respect core.autocrlf
      <span class="help-tip" title="Honor the repository's line-ending settings when reading/writing files.">?</span>
    </label>
  </div>
</form>
`.trim();

const LfsSettingsHtml = `
<form class="panel-form" data-panel="lfs">
  <div class="group">
    <label class="checkbox"><input type="checkbox" id="set-lfs-enabled" /> Enable LFS integration
      <span class="help-tip" title="Support Git LFS for large files (download pointers as real files).">?</span>
    </label>
  </div>
  <div class="group">
    <label for="set-lfs-concurrency">Concurrent transfers
      <span class="help-tip" title="Number of parallel LFS uploads/downloads.">?</span>
    </label>
    <input id="set-lfs-concurrency" type="number" min="1" max="16" />
  </div>
  <div class="group">
    <label class="checkbox"><input type="checkbox" id="set-lfs-require-lock" /> Require lock before edit
      <span class="help-tip" title="Prevent conflicting edits by requiring an LFS lock.">?</span>
    </label>
  </div>
  <div class="group">
    <label class="checkbox"><input type="checkbox" id="set-lfs-bg-fetch" /> Background fetch on checkout
      <span class="help-tip" title="Fetch LFS objects automatically after switching branches.">?</span>
    </label>
  </div>
</form>
`.trim();

const LfsMenubarHtml = `
<div class="menu" data-menu="lfs">
  <button class="menu-trigger" type="button" aria-haspopup="true" aria-expanded="false">LFS</button>
  <div class="menu-list" role="menu" hidden>
    <button class="menu-item" role="menuitem" data-action="lfs-pull-all">Download LFS Files</button>
    <button class="menu-item" role="menuitem" data-action="lfs-fetch-all">Fetch LFS</button>
    <button class="menu-item" role="menuitem" data-action="lfs-prune">Prune LFS Cache</button>
    <div class="menu-sep" role="separator"></div>
    <button class="menu-item" role="menuitem" data-action="lfs-manage-locks">Manage LFS Locks…</button>
    <button class="menu-item" role="menuitem" data-action="lfs-refresh-locks">Refresh LFS Locks Cache</button>
    <button class="menu-item" role="menuitem" data-action="lfs-settings">LFS Preferences…</button>
  </div>
</div>
`.trim();

const SubmoduleMenubarHtml = `
<div class="menu" data-menu="submodules">
  <button class="menu-trigger" type="button" aria-haspopup="true" aria-expanded="false">Submodules</button>
  <div class="menu-list" role="menu" hidden>
    <button class="menu-item" role="menuitem" data-action="submodules-list">List submodules</button>
    <button class="menu-item" role="menuitem" data-action="submodules-update-all">Update all (init + recursive)</button>
    <button class="menu-item" role="menuitem" data-action="submodules-sync-all">Sync all (recursive)</button>
    <div class="menu-sep" role="separator"></div>
    <button class="menu-item" role="menuitem" data-action="submodules-add">Add submodule…</button>
  </div>
</div>
`.trim();

(() => {
  const trim = (value) => String(value ?? '').trim();
  const normalizePath = (value) => trim(value).replace(/\\/g, '/').replace(/^\.\//, '');
  const toArray = (value) => Array.isArray(value) ? value : [];

  const notify = (message) => {
    try {
      window.OpenVCS?.notify?.(String(message || ''));
    } catch {
      // ignore
    }
  };

  const notifyError = (prefix, error) => {
    const msg = trim(error);
    notify(msg ? `${prefix}: ${msg}` : prefix);
  };

  const invoke = async (cmd, args) => {
    if (!window.OpenVCS?.invoke) throw new Error('invoke unavailable');
    return window.OpenVCS.invoke(cmd, args);
  };

  const getCfg = async () => {
    try {
      return await invoke('get_global_settings');
    } catch {
      return null;
    }
  };

  const getRepoPath = async () => {
    try {
      const path = await invoke('current_repo_path');
      const value = trim(path);
      return value || null;
    } catch {
      return null;
    }
  };

  const gitBackend = (cfg) => trim(cfg?.git?.backend) || 'system';
  const lfsCfg = (cfg) => cfg?.lfs ?? null;

  const callGit = async (method, extra, includeLfs = true) => {
    const path = await getRepoPath();
    if (!path) throw new Error('No repository selected');
    const cfg = await getCfg();
    const params = {
      path,
      git_backend: gitBackend(cfg),
      ...(includeLfs ? { lfs: lfsCfg(cfg) } : {}),
      ...(extra || {}),
    };
    return invoke('call_vcs_backend_method', {
      backendId: 'git',
      method: trim(method),
      params,
    });
  };

  const callSubmodule = async (method, extra) => {
    return callGit(method, extra, false);
  };

  const selectedPathsFromPayload = (payload) => {
    return toArray(payload?.paths).map((p) => normalizePath(p)).filter(Boolean);
  };

  const selectedSubmodulePath = (payload) => {
    const file = payload?.file || null;
    const status = trim(file?.status).toUpperCase();
    if (status !== 'S') return '';
    return normalizePath(file?.path || payload?.clickedPath);
  };

  let lockMap = new Map();

  const refreshLocks = async (refresh) => {
    const cfg = await getCfg();
    if (cfg?.lfs?.enabled === false) {
      lockMap = new Map();
      return [];
    }
    try {
      const available = await callGit('git.lfs.is_available', {}, false);
      if (!available) {
        lockMap = new Map();
        return [];
      }
      const locks = await callGit('git.lfs.locks', { cached: !refresh }, true);
      const out = toArray(locks);
      const next = new Map();
      for (const lock of out) {
        const path = normalizePath(lock?.path);
        if (!path) continue;
        next.set(path, lock);
      }
      lockMap = next;
      return out;
    } catch {
      lockMap = new Map();
      return [];
    }
  };

  const showLfsLockPrompt = async () => {
    const locks = await refreshLocks(true);
    const preview = locks.slice(0, 10).map((lock) => {
      const p = normalizePath(lock?.path);
      const owner = trim(lock?.owner);
      return owner ? `- ${p} (${owner})` : `- ${p}`;
    }).join('\n');
    const heading = `Git LFS locks: ${locks.length}`;
    const body = preview ? `\n${preview}${locks.length > 10 ? '\n…' : ''}` : '\n(no locks)';
    const hint = '\n\nEnter +path to lock, -path to unlock, or leave blank to close.';
    const input = window.prompt(`${heading}${body}${hint}`);
    const value = trim(input);
    if (!value) return;
    const force = value.startsWith('!');
    const raw = force ? value.slice(1) : value;
    const action = raw.startsWith('-') ? 'unlock' : 'lock';
    const path = normalizePath(raw.replace(/^[-+]/, ''));
    if (!path) return;

    if (action === 'unlock') {
      await callGit('git.lfs.unlock_paths', { paths: [path], force }, true);
      notify(force ? 'Force-unlocked file in Git LFS' : 'Unlocked file in Git LFS');
    } else {
      await callGit('git.lfs.lock_paths', { paths: [path] }, true);
      notify('Locked file in Git LFS');
    }
    await refreshLocks(true);
  };

  const showSubmoduleList = async () => {
    const available = await callSubmodule('git.submodule.is_available');
    if (!available) {
      notify('Submodule operations are unavailable for this backend/repository');
      return;
    }
    const list = toArray(await callSubmodule('git.submodule.list'));
    if (!list.length) {
      notify('No submodules found');
      return;
    }
    const preview = list.slice(0, 15).map((item) => {
      const path = normalizePath(item?.path);
      const branch = trim(item?.branch);
      return branch ? `- ${path} [${branch}]` : `- ${path}`;
    }).join('\n');
    window.alert(
      `Submodules (${list.length})\n\n${preview}${list.length > 15 ? '\n…' : ''}`,
    );
  };

  const addSubmodulePrompt = async () => {
    const url = trim(window.prompt('Submodule URL'));
    if (!url) return;
    const submodulePath = normalizePath(window.prompt('Submodule path (relative to repo root)'));
    if (!submodulePath) return;
    await callSubmodule('git.submodule.add', { url, submodule_path: submodulePath });
    notify('Submodule added');
    window.dispatchEvent(new CustomEvent('app:status-updated'));
  };

  window.OpenVCS?.addSettingsSection?.({
    id: 'git',
    label: 'Git',
    after: 'general',
    before: 'diff',
    html: GitSettingsHtml,
  });

  window.OpenVCS?.addSettingsSection?.({
    id: 'lfs',
    label: 'LFS',
    after: 'diff',
    before: 'performance',
    html: LfsSettingsHtml,
  });

  window.OpenVCS?.addMenubarMenu?.({
    id: 'submodules',
    after: 'repository',
    before: 'lfs',
    html: SubmoduleMenubarHtml,
  });

  window.OpenVCS?.addMenubarMenu?.({
    id: 'lfs',
    after: 'submodules',
    before: 'help',
    html: LfsMenubarHtml,
  });

  window.OpenVCS?.registerPlugin?.({
    id: 'openvcs.git',
    actions: {
      'lfs-fetch-all': async () => {
        try {
          await callGit('git.lfs.fetch_all', {}, true);
          notify('Fetched Git LFS objects');
        } catch (error) {
          notifyError('Git LFS fetch failed', error);
        }
      },
      'lfs-pull-all': async () => {
        try {
          await callGit('git.lfs.pull', {}, true);
          notify('Pulled Git LFS objects');
        } catch (error) {
          notifyError('Git LFS pull failed', error);
        }
      },
      'lfs-prune': async () => {
        try {
          await callGit('git.lfs.prune', {}, true);
          notify('Pruned Git LFS cache');
        } catch (error) {
          notifyError('Git LFS prune failed', error);
        }
      },
      'lfs-refresh-locks': async () => {
        await refreshLocks(true);
        notify('Refreshed Git LFS locks');
      },
      'lfs-manage-locks': async () => {
        try {
          await showLfsLockPrompt();
        } catch (error) {
          notifyError('Git LFS lock management failed', error);
        }
      },
      'git-lfs-track': async (payload) => {
        const paths = selectedPathsFromPayload(payload);
        if (!paths.length) return;
        try {
          await callGit('git.lfs.track_paths', { paths }, true);
          notify(paths.length > 1 ? 'Tracked files with Git LFS' : 'Tracked file with Git LFS');
        } catch (error) {
          notifyError('Git LFS track failed', error);
        }
      },
      'git-lfs-untrack': async (payload) => {
        const paths = selectedPathsFromPayload(payload);
        if (!paths.length) return;
        try {
          await callGit('git.lfs.untrack_paths', { paths }, true);
          notify(paths.length > 1 ? 'Removed from Git LFS' : 'Removed from Git LFS');
        } catch (error) {
          notifyError('Git LFS untrack failed', error);
        }
      },
      'git-lfs-toggle-lock': async (payload) => {
        const selected = selectedPathsFromPayload(payload);
        const clicked = normalizePath(payload?.clickedPath);
        const paths = (selected.length ? selected : (clicked ? [clicked] : [])).filter(Boolean);
        if (!paths.length) return;
        try {
          await refreshLocks(true);
          const locked = paths.filter((path) => lockMap.has(path));
          const unlocked = paths.filter((path) => !lockMap.has(path));
          if (unlocked.length) {
            await callGit('git.lfs.lock_paths', { paths: unlocked }, true);
            notify(unlocked.length > 1 ? 'Locked files in Git LFS' : 'Locked file in Git LFS');
          } else if (locked.length) {
            await callGit('git.lfs.unlock_paths', { paths: locked }, true);
            notify(locked.length > 1 ? 'Unlocked files in Git LFS' : 'Unlocked file in Git LFS');
          }
          await refreshLocks(true);
        } catch (error) {
          notifyError('Git LFS lock toggle failed', error);
        }
      },
      'submodules-list': async () => {
        try {
          await showSubmoduleList();
        } catch (error) {
          notifyError('Submodule list failed', error);
        }
      },
      'submodules-update-all': async () => {
        try {
          await callSubmodule('git.submodule.update', { init: true, recursive: true, remote: false, paths: [] });
          notify('Updated submodules');
          window.dispatchEvent(new CustomEvent('app:status-updated'));
        } catch (error) {
          notifyError('Submodule update failed', error);
        }
      },
      'submodules-sync-all': async () => {
        try {
          await callSubmodule('git.submodule.sync', { recursive: true, paths: [] });
          notify('Synced submodule remotes');
        } catch (error) {
          notifyError('Submodule sync failed', error);
        }
      },
      'submodules-add': async () => {
        try {
          await addSubmodulePrompt();
        } catch (error) {
          notifyError('Submodule add failed', error);
        }
      },
      'submodule-update-path': async (payload) => {
        const path = selectedSubmodulePath(payload);
        if (!path) return;
        try {
          await callSubmodule('git.submodule.update', { init: true, recursive: true, remote: false, paths: [path] });
          notify(`Updated submodule ${path}`);
          window.dispatchEvent(new CustomEvent('app:status-updated'));
        } catch (error) {
          notifyError('Submodule update failed', error);
        }
      },
      'submodule-sync-path': async (payload) => {
        const path = selectedSubmodulePath(payload);
        if (!path) return;
        try {
          await callSubmodule('git.submodule.sync', { recursive: true, paths: [path] });
          notify(`Synced submodule ${path}`);
        } catch (error) {
          notifyError('Submodule sync failed', error);
        }
      },
      'submodule-remove-path': async (payload) => {
        const path = selectedSubmodulePath(payload);
        if (!path) return;
        const ok = window.confirm(`Remove submodule ${path}? This removes mapping and stages deletion.`);
        if (!ok) return;
        try {
          await callSubmodule('git.submodule.remove', { submodule_path: path, force: false });
          notify(`Removed submodule ${path}`);
          window.dispatchEvent(new CustomEvent('app:status-updated'));
        } catch (error) {
          notifyError('Submodule remove failed', error);
        }
      },
    },
    contextMenus: {
      files: [
        { label: 'Lock file', action: 'git-lfs-toggle-lock' },
        { label: 'Submodule: Update', action: 'submodule-update-path' },
        { label: 'Submodule: Sync', action: 'submodule-sync-path' },
        { label: 'Submodule: Remove', action: 'submodule-remove-path' },
      ],
    },
    menubarMenus: [
      {
        id: 'submodules',
        after: 'repository',
        before: 'lfs',
        html: SubmoduleMenubarHtml,
      },
      {
        id: 'lfs',
        after: 'submodules',
        before: 'help',
        html: LfsMenubarHtml,
      },
    ],
  });

  window.addEventListener('app:status-updated', () => {
    refreshLocks(false).catch(() => {});
  });
  window.addEventListener('app:repo-selected', () => {
    refreshLocks(true).catch(() => {});
  });
  window.addEventListener('app:repo-will-switch', () => {
    lockMap = new Map();
  });

  refreshLocks(false).catch(() => {});
})();
