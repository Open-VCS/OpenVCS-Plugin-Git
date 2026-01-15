// OpenVCS Git plugin UI entry (runs in the UI as an ESM module).
// Adds Git/LFS settings sections and the LFS menubar dropdown when enabled.

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
    <button class="menu-item" role="menuitem" data-action="lfs-settings">LFS Preferences…</button>
  </div>
</div>
`.trim();

try {
  const pluginId = (window.__openvcsPluginContext?.id || 'openvcs.git');

  const getRepoPath = async () => {
    try { return await window.OpenVCS?.invoke?.('current_repo_path'); } catch { return null; }
  };

  const getCfg = async () => {
    try { return await window.OpenVCS?.invoke?.('get_global_settings'); } catch { return null; }
  };

  const call = async (method, extra) => {
    const path = await getRepoPath();
    if (!path) {
      window.OpenVCS?.notify?.('No repository selected');
      return;
    }
    const cfg = await getCfg();
    const git_backend = String(cfg?.git?.backend || 'system');
    const lfs = cfg?.lfs || null;
    return window.OpenVCS?.invoke?.('call_vcs_backend_method', {
      backendId: 'git',
      method,
      params: { path, git_backend, lfs, ...(extra || {}) },
    });
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
    id: 'lfs',
    after: 'repository',
    before: 'help',
    html: LfsMenubarHtml,
  });

  window.OpenVCS?.registerPlugin?.({
    actions: {
      'lfs-fetch-all': async () => {
        try {
          await call('git.lfs.fetch_all');
          window.OpenVCS?.notify?.('Fetched Git LFS objects');
        } catch (e) {
          window.OpenVCS?.notify?.(`Git LFS fetch failed: ${String(e || '').trim() || 'unknown error'}`);
        }
      },
      'lfs-pull-all': async () => {
        try {
          await call('git.lfs.pull');
          window.OpenVCS?.notify?.('Pulled Git LFS objects');
        } catch (e) {
          window.OpenVCS?.notify?.(`Git LFS pull failed: ${String(e || '').trim() || 'unknown error'}`);
        }
      },
      'lfs-prune': async () => {
        try {
          await call('git.lfs.prune');
          window.OpenVCS?.notify?.('Pruned Git LFS cache');
        } catch (e) {
          window.OpenVCS?.notify?.(`Git LFS prune failed: ${String(e || '').trim() || 'unknown error'}`);
        }
      },
      'git-lfs-track': async (payload) => {
        const paths = Array.isArray(payload?.paths) ? payload.paths : [];
        try {
          await call('git.lfs.track_paths', { paths });
          window.OpenVCS?.notify?.(paths.length > 1 ? 'Tracked files with Git LFS' : 'Tracked file with Git LFS');
        } catch (e) {
          window.OpenVCS?.notify?.(`Git LFS track failed: ${String(e || '').trim() || 'unknown error'}`);
        }
      },
      'git-lfs-untrack': async (payload) => {
        const paths = Array.isArray(payload?.paths) ? payload.paths : [];
        try {
          await call('git.lfs.untrack_paths', { paths });
          window.OpenVCS?.notify?.(paths.length > 1 ? 'Removed from Git LFS' : 'Removed from Git LFS');
        } catch (e) {
          window.OpenVCS?.notify?.(`Git LFS untrack failed: ${String(e || '').trim() || 'unknown error'}`);
        }
      },
    },
    contextMenus: {
      files: [
        { label: 'Add to Git LFS', action: 'git-lfs-track' },
        { label: 'Remove from Git LFS', action: 'git-lfs-untrack' },
      ],
    },
    // Also register the menubar menu via the plugin registration API as a
    // fallback in case the global `addMenubarMenu` helper is not present in
    // the host runtime. This avoids the LFS menu silently not appearing.
    menubarMenus: [
      {
        id: 'lfs',
        after: 'repository',
        before: 'help',
        html: LfsMenubarHtml,
      },
    ],
  });
} catch (e) {
  // Plugin UI contributions are best-effort; ignore failures.
  void e;
}
