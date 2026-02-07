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

const SubmoduleModalHtml = `
<div class="modal submodules-modal" id="submodules-modal" aria-hidden="true">
  <div class="dialog sheet" role="dialog" aria-modal="true" aria-labelledby="submodules-title">
    <div class="sheet-head">
      <h3 id="submodules-title" style="margin:0">Submodules</h3>
      <button class="icon close" type="button" data-close aria-label="Close">✕</button>
    </div>
    <div class="sheet-body">
      <div class="panel-form">
        <div class="group"><div class="modal-note" id="submodules-state"></div></div>
        <div class="group">
          <label>Repository submodules</label>
          <div class="submodules-list" id="submodules-list"></div>
          <div class="modal-note" id="submodules-empty" hidden>No submodules found.</div>
        </div>
      </div>
    </div>
    <div class="sheet-actions">
      <button class="tbtn" id="submodules-refresh" type="button">Refresh</button>
      <button class="tbtn" id="submodules-update-all" type="button">Update All</button>
      <button class="tbtn" id="submodules-sync-all" type="button">Sync All</button>
      <button class="tbtn primary" id="submodules-add" type="button">Add…</button>
      <button class="tbtn" type="button" data-close>Close</button>
    </div>
  </div>
  <div class="backdrop" data-close></div>
</div>
`.trim();

const LfsLocksModalHtml = `
<div class="modal lfs-locks-modal" id="lfs-locks-modal" aria-hidden="true">
  <div class="dialog sheet" role="dialog" aria-modal="true" aria-labelledby="lfs-locks-title">
    <div class="sheet-head">
      <h3 id="lfs-locks-title" style="margin:0">LFS Locks</h3>
      <button class="icon close" type="button" data-close aria-label="Close">✕</button>
    </div>
    <div class="sheet-body">
      <div class="panel-form lfs-locks-form">
        <div class="lfs-locks-hero">
          <div class="lfs-locks-hero-text">
            <div class="modal-note">Manage Git LFS locks for this repository.</div>
            <div class="lfs-locks-force-hint" id="lfs-locks-force-hint">Hold Shift while clicking Unlock to force unlock.</div>
          </div>
          <div class="lfs-locks-count" id="lfs-locks-count">0 locks</div>
        </div>
        <div class="group">
          <label for="lfs-locks-path">Lock path</label>
          <div class="lfs-locks-input-row">
            <input id="lfs-locks-path" type="text" placeholder="path/to/asset.bin" />
            <button class="tbtn primary" id="lfs-locks-create" type="button">Create lock</button>
          </div>
          <div class="modal-note">Paths are relative to the repository root.</div>
          <div class="modal-note" id="lfs-locks-state"></div>
        </div>
        <div class="group">
          <label>Current locks</label>
          <div class="lfs-locks-list" id="lfs-locks-list"></div>
          <div class="modal-note" id="lfs-locks-empty" hidden>No locks found.</div>
        </div>
      </div>
    </div>
    <div class="sheet-actions">
      <button class="tbtn" id="lfs-locks-refresh" type="button">Refresh</button>
      <button class="tbtn" type="button" data-close>Close</button>
    </div>
  </div>
  <div class="backdrop" data-close></div>
</div>
`.trim();

try {
  const pluginId = (window.__openvcsPluginContext?.id || 'openvcs.git');

  const getRepoPath = async () => {
    try { return await window.OpenVCS?.invoke?.('current_repo_path'); } catch { return null; }
  };
  const joinRepoPath = (base, rel) => {
    const b = String(base || '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
    const r = String(rel || '').trim().replace(/\\/g, '/').replace(/^\/+/, '');
    if (!b || !r) return '';
    return `${b}/${r}`;
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
  const getGitBackend = async () => {
    const cfg = await getCfg();
    return String(cfg?.git?.backend || 'system');
  };
  const callSubmodule = async (method, extra) => {
    const path = await getRepoPath();
    if (!path) {
      window.OpenVCS?.notify?.('No repository selected');
      return null;
    }
    const git_backend = await getGitBackend();
    return window.OpenVCS?.invoke?.('call_vcs_backend_method', {
      backendId: 'git',
      method,
      params: { path, git_backend, ...(extra || {}) },
    });
  };

  const ensureLockStyle = () => {
    if (document.getElementById('openvcs-lfs-lock-style')) return;
    const style = document.createElement('style');
    style.id = 'openvcs-lfs-lock-style';
    style.textContent = `
      .lfs-lock-mark{ color:var(--warning); opacity:0; transition:opacity .15s; font-weight:700; font-size:.7rem; letter-spacing:.04em; }
      .row.lfs-locked .lfs-lock-mark{ opacity:1; }
      .ctxmenu .item.lfs-disabled{ opacity:.45; pointer-events:none; }
      .menu.lfs-disabled .menu-trigger{ opacity:.5; pointer-events:none; }
      .menu.lfs-disabled .menu-list .menu-item{ opacity:.5; pointer-events:none; }
      .lfs-locks-modal .dialog.sheet{ width:min(760px, 96vw); }
      .lfs-locks-modal .sheet-body{ max-height:70vh; overflow:auto; }
      .lfs-locks-hero{ display:flex; justify-content:space-between; align-items:center; gap:1rem; padding:.4rem 0 .6rem; }
      .lfs-locks-hero-text{ display:grid; gap:.2rem; }
      .lfs-locks-force-hint{ color:var(--muted); font-size:.85rem; }
      .lfs-locks-force-hint.active{ color:var(--danger); font-weight:600; }
      .lfs-locks-count{ font-size:.85rem; color:var(--muted); border:1px solid var(--border); padding:.2rem .55rem; border-radius:999px; background:var(--surface-2); }
      .lfs-locks-form .group{ display:grid; gap:.5rem; }
      .lfs-locks-input-row{ display:grid; grid-template-columns:1fr auto; gap:.5rem; align-items:center; }
      .lfs-locks-list{ display:grid; gap:.5rem; }
      .lfs-lock-row{ display:grid; grid-template-columns:1fr auto; gap:.75rem; align-items:center; padding:.6rem .7rem; border:1px solid var(--border); border-radius:10px; background:var(--surface-2); }
      .lfs-lock-path{ font-weight:600; word-break:break-all; }
      .lfs-lock-meta{ color:var(--muted); font-size:.85rem; display:flex; flex-wrap:wrap; gap:.5rem; }
      .lfs-lock-chip{ display:inline-flex; align-items:center; gap:.25rem; padding:.15rem .4rem; border-radius:999px; border:1px solid var(--border); background:var(--surface); font-size:.78rem; }
      .submodules-modal .dialog.sheet{ width:min(840px, 96vw); }
      .submodules-modal .sheet-body{ max-height:70vh; overflow:auto; }
      .submodules-list{ display:grid; gap:.5rem; }
      .submodule-row{ display:grid; grid-template-columns:1fr auto; gap:.75rem; align-items:center; padding:.6rem .7rem; border:1px solid var(--border); border-radius:10px; background:var(--surface-2); }
      .submodule-path{ font-weight:600; word-break:break-all; }
      .submodule-meta{ color:var(--muted); font-size:.85rem; display:flex; flex-wrap:wrap; gap:.5rem; }
      .submodule-actions{ display:flex; gap:.4rem; flex-wrap:wrap; justify-content:flex-end; }
      .submodule-chip{ display:inline-flex; align-items:center; gap:.25rem; padding:.15rem .4rem; border-radius:999px; border:1px solid var(--border); background:var(--surface); font-size:.78rem; }
    `;
    document.head.appendChild(style);
  };

  const lockTitle = (lock) => {
    const owner = String(lock?.owner || '').trim();
    const who = owner ? ` by ${owner}` : '';
    return `LFS lock${who}`;
  };

  const normalizePath = (value) => String(value || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
  const escapeCss = (value) => {
    if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value);
    return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  };
  let lfsAvailable = true;
  let lockMap = new Map();
  let lfsLocksModalOverflow = null;
  let submodulesModalOverflow = null;
  let forceUnlockHeld = false;
  let lastLocksSignature = '';
  let lastSubmodulesSignature = '';
  const updateLockMarks = (locks) => {
    ensureLockStyle();
    const map = new Map();
    (Array.isArray(locks) ? locks : []).forEach((lock) => {
      const path = normalizePath(lock?.path || '');
      if (path) map.set(path, lock);
    });
    const prevMap = lockMap;
    lockMap = map;
    if (lockMap.size === 0 && prevMap.size === 0) return;
    const touched = new Set();
    prevMap.forEach((_value, path) => touched.add(path));
    lockMap.forEach((_value, path) => touched.add(path));
    if (touched.size === 0) return;
    touched.forEach((path) => {
      const row = document.querySelector(`li.row[data-path="${escapeCss(path)}"]`);
      if (!row) return;
      const marks = row.querySelector('.row-marks');
      if (!marks) return;
      let mark = marks.querySelector('.lfs-lock-mark');
      if (!mark) {
        mark = document.createElement('span');
        mark.className = 'lfs-lock-mark';
        mark.setAttribute('aria-hidden', 'true');
        mark.textContent = 'LOCK';
        marks.appendChild(mark);
      }
      const lock = lockMap.get(path) || null;
      row.classList.toggle('lfs-locked', !!lock);
      if (lock) {
        mark.setAttribute('title', lockTitle(lock));
      } else {
        mark.removeAttribute('title');
      }
    });
  };

  const renderLfsLocks = (locks) => {
    const list = document.getElementById('lfs-locks-list');
    const empty = document.getElementById('lfs-locks-empty');
    const count = document.getElementById('lfs-locks-count');
    if (!list || !empty) return;
    list.innerHTML = '';
    if (count) {
      const total = Array.isArray(locks) ? locks.length : 0;
      count.textContent = `${total} lock${total === 1 ? '' : 's'}`;
    }
    if (!Array.isArray(locks) || locks.length === 0) {
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    locks.forEach((lock) => {
      const row = document.createElement('div');
      row.className = 'lfs-lock-row';
      row.setAttribute('data-path', String(lock?.path || ''));

      const left = document.createElement('div');
      const path = document.createElement('div');
      path.className = 'lfs-lock-path';
      path.textContent = String(lock?.path || '');
      const meta = document.createElement('div');
      meta.className = 'lfs-lock-meta';

      const owner = String(lock?.owner || '').trim();
      const lockedAt = String(lock?.locked_at || '').trim();
      const ownerChip = document.createElement('span');
      ownerChip.className = 'lfs-lock-chip';
      ownerChip.textContent = owner ? `Owner: ${owner}` : 'Owner: unknown';
      meta.appendChild(ownerChip);
      if (lockedAt) {
        const timeChip = document.createElement('span');
        timeChip.className = 'lfs-lock-chip';
        timeChip.textContent = `Locked: ${lockedAt}`;
        meta.appendChild(timeChip);
      }
      const id = String(lock?.id || '').trim();
      if (id) {
        const idChip = document.createElement('span');
        idChip.className = 'lfs-lock-chip';
        idChip.textContent = `ID: ${id}`;
        meta.appendChild(idChip);
      }

      left.appendChild(path);
      left.appendChild(meta);

      const button = document.createElement('button');
      button.className = 'tbtn';
      button.type = 'button';
      button.textContent = forceUnlockHeld ? 'Force unlock' : 'Unlock';
      if (forceUnlockHeld) button.classList.add('danger');
      button.setAttribute('data-action', 'unlock');
      button.setAttribute('data-path', String(lock?.path || ''));

      row.appendChild(left);
      row.appendChild(button);
      list.appendChild(row);
    });
  };

  const applyLocks = (locks) => {
    updateLockMarks(locks);
    if (isLfsLocksModalOpen()) {
      const signature = lockSignature(locks);
      if (signature !== lastLocksSignature) {
        lastLocksSignature = signature;
        renderLfsLocks(locks);
      }
    }
    updateContextMenuLabel();
  };

  const lockSignature = (locks) => {
    if (!Array.isArray(locks) || locks.length === 0) return '';
    return locks
      .map((lock) => [
        String(lock?.path || ''),
        String(lock?.id || ''),
        String(lock?.owner || ''),
        String(lock?.locked_at || ''),
      ].join('|'))
      .sort()
      .join('||');
  };

  const isLfsLocksModalOpen = () => {
    const modal = document.getElementById('lfs-locks-modal');
    return !!modal && modal.getAttribute('aria-hidden') === 'false';
  };

  const updateForceUnlockUi = (held) => {
    if (forceUnlockHeld === held) return;
    forceUnlockHeld = held;
    const modal = document.getElementById('lfs-locks-modal');
    if (!modal) return;
    const hint = modal.querySelector('#lfs-locks-force-hint');
    if (hint) {
      hint.textContent = held
        ? 'Force unlock enabled (Shift).'
        : 'Hold Shift while clicking Unlock to force unlock.';
      hint.classList.toggle('active', held);
    }
    const buttons = modal.querySelectorAll('[data-action="unlock"]');
    buttons.forEach((btn) => {
      if (!(btn instanceof HTMLButtonElement)) return;
      btn.textContent = held ? 'Force unlock' : 'Unlock';
      btn.classList.toggle('danger', held);
    });
  };

  const fetchLocks = async (options) => {
    const cached = options?.refresh !== true;
    if (!lfsAvailable) return [];
    const path = await getRepoPath();
    if (!path) return [];
    const cfg = await getCfg();
    const lfs = cfg?.lfs || null;
    if (lfs && lfs.enabled === false) return [];
    const git_backend = String(cfg?.git?.backend || 'system');
    try {
      const res = await window.OpenVCS?.invoke?.('call_vcs_backend_method', {
        backendId: 'git',
        method: 'git.lfs.locks',
        params: { path, git_backend, lfs, cached },
      });
      return Array.isArray(res) ? res : [];
    } catch {
      return [];
    }
  };

  let lockRefreshInFlight = false;
  const refreshLocks = async (options) => {
    if (lockRefreshInFlight) return;
    lockRefreshInFlight = true;
    try {
      const locks = await fetchLocks(options);
      applyLocks(locks);
    } finally {
      lockRefreshInFlight = false;
    }
  };

  const updateLfsAvailability = (available) => {
    lfsAvailable = !!available;
    ensureLockStyle();
    const menu = document.querySelector('.menu[data-menu="lfs"]');
    if (menu) {
      menu.classList.toggle('lfs-disabled', !lfsAvailable);
      menu.setAttribute('aria-disabled', String(!lfsAvailable));
    }
    if (!lfsAvailable) applyLocks([]);
    updateContextMenuLabel();
  };

  const refreshLfsAvailability = async () => {
    const path = await getRepoPath();
    if (!path) {
      updateLfsAvailability(false);
      return;
    }
    const cfg = await getCfg();
    const git_backend = String(cfg?.git?.backend || 'system');
    try {
      const res = await window.OpenVCS?.invoke?.('call_vcs_backend_method', {
        backendId: 'git',
        method: 'git.lfs.is_available',
        params: { path, git_backend },
      });
      updateLfsAvailability(!!res);
    } catch {
      updateLfsAvailability(false);
    }
  };

  let lastContextPath = '';
  const updateContextMenuLabel = () => {
    const menu = document.querySelector('.ctxmenu');
    if (!menu) return;
    const items = Array.from(menu.querySelectorAll('.item'));
    if (!items.length) return;
    const target = items.find((el) => {
      const txt = String(el.textContent || '').trim();
      return txt === 'Lock file' || txt === 'Unlock file';
    });
    if (!target) return;
    const locked = lastContextPath && lockMap.has(lastContextPath);
    target.textContent = locked ? 'Unlock file' : 'Lock file';
    target.classList.toggle('lfs-disabled', !lfsAvailable);
  };

  const ensureLfsLocksModal = () => {
    if (document.getElementById('lfs-locks-modal')) return;
    ensureLockStyle();
    const root = document.getElementById('modals-root') || document.body;
    root.insertAdjacentHTML('beforeend', LfsLocksModalHtml);
    const modal = document.getElementById('lfs-locks-modal');
    if (!modal) return;
    if (!(modal).__wired) {
      modal.addEventListener('click', (evt) => {
        const target = evt.target;
        if (!(target instanceof HTMLElement)) return;
        if (target.closest('[data-close]')) {
          closeLfsLocksModal();
        }
      });
      document.addEventListener('keydown', (evt) => {
        if (evt.key !== 'Escape') return;
        if (modal.getAttribute('aria-hidden') === 'false') {
          closeLfsLocksModal();
        }
      });
      const list = modal.querySelector('#lfs-locks-list');
      list?.addEventListener('click', async (evt) => {
        const target = evt.target;
        if (!(target instanceof HTMLElement)) return;
        const btn = target.closest('[data-action="unlock"]');
        if (!btn) return;
        const path = String(btn.getAttribute('data-path') || '').trim();
        if (!path) return;
        try {
          const force = evt.shiftKey || forceUnlockHeld;
          await call('git.lfs.unlock_paths', { paths: [path], force });
          window.OpenVCS?.notify?.(force ? 'Force-unlocked file in Git LFS' : 'Unlocked file in Git LFS');
          await refreshLocks({ refresh: true });
        } catch (e) {
          window.OpenVCS?.notify?.(`Git LFS unlock failed: ${String(e || '').trim() || 'unknown error'}`);
        }
      });
      const createBtn = modal.querySelector('#lfs-locks-create');
      const refreshBtn = modal.querySelector('#lfs-locks-refresh');
      const input = modal.querySelector('#lfs-locks-path');
      createBtn?.addEventListener('click', async () => {
        const value = String(input?.value || '').trim();
        if (!value) {
          window.OpenVCS?.notify?.('Enter a path to lock');
          return;
        }
        try {
          await call('git.lfs.lock_paths', { paths: [value] });
          window.OpenVCS?.notify?.('Locked file in Git LFS');
          if (input) input.value = '';
          await refreshLocks({ refresh: true });
        } catch (e) {
          const msg = String(e || '').trim();
          if (msg.toLowerCase().includes('lock exists')) {
            window.OpenVCS?.notify?.('Git LFS lock already exists');
          } else {
            window.OpenVCS?.notify?.(`Git LFS lock failed: ${msg || 'unknown error'}`);
          }
          await refreshLocks({ refresh: true });
        }
      });
      input?.addEventListener('keydown', (evt) => {
        if (evt.key === 'Enter') {
          evt.preventDefault();
          createBtn?.dispatchEvent(new Event('click'));
        }
      });
      refreshBtn?.addEventListener('click', async () => {
        await refreshLocks({ refresh: true });
      });
      const handleShift = (evt) => {
        if (evt.key !== 'Shift') return;
        if (modal.getAttribute('aria-hidden') !== 'false') return;
        if (evt.type === 'keydown' && evt.repeat) return;
        updateForceUnlockUi(evt.type === 'keydown');
      };
      document.addEventListener('keydown', handleShift);
      document.addEventListener('keyup', handleShift);
      window.addEventListener('blur', () => updateForceUnlockUi(false));
      (modal).__wired = true;
    }
  };

  const setLfsLocksModalState = (state) => {
    const modal = document.getElementById('lfs-locks-modal');
    if (!modal) return;
    const note = modal.querySelector('#lfs-locks-state');
    if (note) {
      note.textContent = state.message || '';
      note.style.display = state.message ? 'block' : 'none';
    }
    const disable = !state.available;
    const controls = modal.querySelectorAll('#lfs-locks-path, #lfs-locks-create, #lfs-locks-refresh, [data-action="unlock"]');
    controls.forEach((el) => { el.disabled = disable; });
  };

  const refreshLfsLocksModal = async () => {
    const path = await getRepoPath();
    if (!path) {
      setLfsLocksModalState({ available: false, message: 'Select a repository to manage Git LFS locks.' });
      applyLocks([]);
      return;
    }
    const cfg = await getCfg();
    if (cfg?.lfs?.enabled === false) {
      setLfsLocksModalState({ available: false, message: 'Enable Git LFS integration in Settings to manage locks.' });
      applyLocks([]);
      return;
    }
    if (!lfsAvailable) {
      setLfsLocksModalState({ available: false, message: 'Git LFS is not available for this repository.' });
      applyLocks([]);
      return;
    }
    setLfsLocksModalState({ available: true, message: '' });
    await refreshLocks();
  };

  const openLfsLocksModal = async () => {
    const path = await getRepoPath();
    if (!path) {
      window.OpenVCS?.notify?.('No repository selected');
      return;
    }
    ensureLfsLocksModal();
    const modal = document.getElementById('lfs-locks-modal');
    if (!modal) return;
    if (!modal.hasAttribute('aria-hidden')) modal.setAttribute('aria-hidden', 'true');
    modal.setAttribute('aria-hidden', 'false');
    updateForceUnlockUi(false);
    if (lfsLocksModalOverflow === null) {
      lfsLocksModalOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
    }
    await refreshLfsLocksModal();
    const input = modal.querySelector('#lfs-locks-path');
    if (input instanceof HTMLElement) input.focus();
  };

  const closeLfsLocksModal = () => {
    const modal = document.getElementById('lfs-locks-modal');
    if (!modal) return;
    if (modal.getAttribute('aria-hidden') !== 'true') {
      modal.setAttribute('aria-hidden', 'true');
    }
    updateForceUnlockUi(false);
    if (lfsLocksModalOverflow !== null) {
      document.body.style.overflow = lfsLocksModalOverflow;
      lfsLocksModalOverflow = null;
    }
  };

  const submoduleSignature = (items) => {
    if (!Array.isArray(items) || items.length === 0) return '';
    return items.map((s) => [
      String(s?.path || ''),
      String(s?.url || ''),
      String(s?.branch || ''),
      s?.initialized ? '1' : '0',
      s?.dirty ? '1' : '0',
      s?.conflicted ? '1' : '0',
    ].join('|')).sort().join('||');
  };

  const renderSubmoduleRows = (items) => {
    const list = document.getElementById('submodules-list');
    const empty = document.getElementById('submodules-empty');
    if (!list || !empty) return;
    list.innerHTML = '';
    if (!Array.isArray(items) || items.length === 0) {
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    items.forEach((s) => {
      const path = String(s?.path || '').trim();
      if (!path) return;
      const row = document.createElement('div');
      row.className = 'submodule-row';
      row.setAttribute('data-path', path);

      const left = document.createElement('div');
      const title = document.createElement('div');
      title.className = 'submodule-path';
      title.textContent = path;
      const meta = document.createElement('div');
      meta.className = 'submodule-meta';

      const url = String(s?.url || '').trim();
      const branch = String(s?.branch || '').trim();
      const flags = [
        s?.initialized ? null : 'uninitialized',
        s?.dirty ? 'dirty' : null,
        s?.conflicted ? 'conflicted' : null,
      ].filter(Boolean);
      if (url) {
        const c = document.createElement('span');
        c.className = 'submodule-chip';
        c.textContent = `URL: ${url}`;
        meta.appendChild(c);
      }
      if (branch) {
        const c = document.createElement('span');
        c.className = 'submodule-chip';
        c.textContent = `Branch: ${branch}`;
        meta.appendChild(c);
      }
      if (flags.length) {
        const c = document.createElement('span');
        c.className = 'submodule-chip';
        c.textContent = flags.join(', ');
        meta.appendChild(c);
      }
      left.appendChild(title);
      left.appendChild(meta);

      const actions = document.createElement('div');
      actions.className = 'submodule-actions';
      actions.innerHTML = `
        <button class="tbtn" type="button" data-action="sub-open" data-path="${path}">Open</button>
        <button class="tbtn" type="button" data-action="sub-update" data-path="${path}">Update</button>
        <button class="tbtn" type="button" data-action="sub-sync" data-path="${path}">Sync</button>
        <button class="tbtn danger" type="button" data-action="sub-remove" data-path="${path}">Remove</button>
      `;
      row.appendChild(left);
      row.appendChild(actions);
      list.appendChild(row);
    });
  };

  const setSubmodulesModalState = (state) => {
    const modal = document.getElementById('submodules-modal');
    if (!modal) return;
    const note = modal.querySelector('#submodules-state');
    if (note) {
      note.textContent = state.message || '';
      note.style.display = state.message ? 'block' : 'none';
    }
    const disable = !state.available;
    const controls = modal.querySelectorAll('#submodules-refresh, #submodules-update-all, #submodules-sync-all, #submodules-add, [data-action^="sub-"]');
    controls.forEach((el) => { el.disabled = disable; });
  };

  const fetchSubmodules = async () => {
    const available = await callSubmodule('git.submodule.is_available');
    if (!available) return { available: false, items: [] };
    const list = await callSubmodule('git.submodule.list');
    return { available: true, items: Array.isArray(list) ? list : [] };
  };

  const refreshSubmodulesModal = async () => {
    try {
      const path = await getRepoPath();
      if (!path) {
        setSubmodulesModalState({ available: false, message: 'Select a repository to manage submodules.' });
        renderSubmoduleRows([]);
        return;
      }
      const next = await fetchSubmodules();
      if (!next.available) {
        setSubmodulesModalState({ available: false, message: 'Submodule operations are unavailable for this backend.' });
        renderSubmoduleRows([]);
        return;
      }
      setSubmodulesModalState({ available: true, message: '' });
      const sig = submoduleSignature(next.items);
      if (sig !== lastSubmodulesSignature) {
        lastSubmodulesSignature = sig;
        renderSubmoduleRows(next.items);
      }
    } catch (e) {
      setSubmodulesModalState({ available: false, message: `Failed to load submodules: ${String(e || '').trim() || 'unknown error'}` });
      renderSubmoduleRows([]);
    }
  };

  const closeSubmodulesModal = () => {
    const modal = document.getElementById('submodules-modal');
    if (!modal) return;
    if (modal.getAttribute('aria-hidden') !== 'true') {
      modal.setAttribute('aria-hidden', 'true');
    }
    if (submodulesModalOverflow !== null) {
      document.body.style.overflow = submodulesModalOverflow;
      submodulesModalOverflow = null;
    }
  };

  const ensureSubmodulesModal = () => {
    if (document.getElementById('submodules-modal')) return;
    ensureLockStyle();
    const root = document.getElementById('modals-root') || document.body;
    root.insertAdjacentHTML('beforeend', SubmoduleModalHtml);
    const modal = document.getElementById('submodules-modal');
    if (!modal || modal.__wired) return;

    modal.addEventListener('click', async (evt) => {
      const target = evt.target;
      if (!(target instanceof HTMLElement)) return;
      if (target.closest('[data-close]')) {
        closeSubmodulesModal();
        return;
      }
      const btn = target.closest('button[data-action]');
      if (!btn) return;
      const action = String(btn.getAttribute('data-action') || '');
      const path = String(btn.getAttribute('data-path') || '').trim();
      try {
        if (action === 'sub-update' && path) {
          await callSubmodule('git.submodule.update', { init: true, recursive: true, remote: false, paths: [path] });
          window.OpenVCS?.notify?.(`Updated submodule ${path}`);
        } else if (action === 'sub-sync' && path) {
          await callSubmodule('git.submodule.sync', { recursive: true, paths: [path] });
          window.OpenVCS?.notify?.(`Synced submodule ${path}`);
        } else if (action === 'sub-remove' && path) {
          const ok = window.confirm(`Remove submodule ${path}? This removes mapping and stages deletion.`);
          if (!ok) return;
          await callSubmodule('git.submodule.remove', { submodule_path: path, force: false });
          window.OpenVCS?.notify?.(`Removed submodule ${path}`);
        } else if (action === 'sub-open' && path) {
          const base = await getRepoPath();
          const absPath = joinRepoPath(base, path);
          if (!absPath) {
            window.OpenVCS?.notify?.('No repository selected');
            return;
          }
          await window.OpenVCS?.invoke?.('open_repo', { path: absPath, backend_id: 'git' });
        } else {
          return;
        }
        window.dispatchEvent(new CustomEvent('app:status-updated'));
        await refreshSubmodulesModal();
      } catch (e) {
        window.OpenVCS?.notify?.(`Submodule action failed: ${String(e || '').trim() || 'unknown error'}`);
      }
    });

    modal.querySelector('#submodules-refresh')?.addEventListener('click', async () => {
      await refreshSubmodulesModal();
    });
    modal.querySelector('#submodules-update-all')?.addEventListener('click', async () => {
      try {
        await callSubmodule('git.submodule.update', { init: true, recursive: true, remote: false, paths: [] });
        window.OpenVCS?.notify?.('Updated submodules');
        window.dispatchEvent(new CustomEvent('app:status-updated'));
        await refreshSubmodulesModal();
      } catch (e) {
        window.OpenVCS?.notify?.(`Submodule update failed: ${String(e || '').trim() || 'unknown error'}`);
      }
    });
    modal.querySelector('#submodules-sync-all')?.addEventListener('click', async () => {
      try {
        await callSubmodule('git.submodule.sync', { recursive: true, paths: [] });
        window.OpenVCS?.notify?.('Synced submodule remotes');
        await refreshSubmodulesModal();
      } catch (e) {
        window.OpenVCS?.notify?.(`Submodule sync failed: ${String(e || '').trim() || 'unknown error'}`);
      }
    });
    modal.querySelector('#submodules-add')?.addEventListener('click', async () => {
      const url = String(window.prompt('Submodule URL', '') || '').trim();
      if (!url) return;
      const submodulePath = String(window.prompt('Submodule path (relative to repo root)', '') || '').trim();
      if (!submodulePath) return;
      try {
        await callSubmodule('git.submodule.add', { url, submodule_path: submodulePath });
        window.OpenVCS?.notify?.('Submodule added');
        window.dispatchEvent(new CustomEvent('app:status-updated'));
        await refreshSubmodulesModal();
      } catch (e) {
        window.OpenVCS?.notify?.(`Submodule add failed: ${String(e || '').trim() || 'unknown error'}`);
      }
    });
    document.addEventListener('keydown', (evt) => {
      if (evt.key !== 'Escape') return;
      if (modal.getAttribute('aria-hidden') === 'false') {
        closeSubmodulesModal();
      }
    });
    modal.__wired = true;
  };

  const openSubmodulesModal = async () => {
    ensureSubmodulesModal();
    const modal = document.getElementById('submodules-modal');
    if (!modal) return;
    if (!modal.hasAttribute('aria-hidden')) modal.setAttribute('aria-hidden', 'true');
    modal.setAttribute('aria-hidden', 'false');
    if (submodulesModalOverflow === null) {
      submodulesModalOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
    }
    await refreshSubmodulesModal();
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
      'lfs-refresh-locks': async () => {
        try {
          await refreshLocks({ refresh: true });
          window.OpenVCS?.notify?.('Refreshed Git LFS locks');
        } catch (e) {
          window.OpenVCS?.notify?.(`Git LFS locks refresh failed: ${String(e || '').trim() || 'unknown error'}`);
        }
      },
      'lfs-manage-locks': async () => {
        try {
          await openLfsLocksModal();
        } catch (e) {
          window.OpenVCS?.notify?.(`Git LFS locks failed: ${String(e || '').trim() || 'unknown error'}`);
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
      'git-lfs-toggle-lock': async (payload) => {
        const rawPaths = Array.isArray(payload?.paths) ? payload.paths : [];
        const clicked = normalizePath(payload?.clickedPath || '');
        const paths = (rawPaths.length ? rawPaths : (clicked ? [clicked] : []))
          .map((p) => normalizePath(p))
          .filter(Boolean);
        try {
          if (!lfsAvailable) {
            window.OpenVCS?.notify?.('Git LFS is not available');
            return;
          }
          const locks = await fetchLocks({ refresh: true });
          applyLocks(locks);
          const locked = paths.filter((p) => lockMap.has(p));
          const unlocked = paths.filter((p) => !lockMap.has(p));
          if (unlocked.length > 0) {
            await call('git.lfs.lock_paths', { paths: unlocked });
            window.OpenVCS?.notify?.(unlocked.length > 1 ? 'Locked files in Git LFS' : 'Locked file in Git LFS');
          } else if (locked.length > 0) {
            await call('git.lfs.unlock_paths', { paths: locked });
            window.OpenVCS?.notify?.(locked.length > 1 ? 'Unlocked files in Git LFS' : 'Unlocked file in Git LFS');
          }
          await refreshLocks({ refresh: true });
        } catch (e) {
          const msg = String(e || '').trim();
          if (msg.toLowerCase().includes('lock exists')) {
            await refreshLocks({ refresh: true });
            window.OpenVCS?.notify?.('Git LFS lock already exists');
          } else {
            window.OpenVCS?.notify?.(`Git LFS lock toggle failed: ${msg || 'unknown error'}`);
          }
        }
      },
      'submodules-list': async () => {
        try {
          await openSubmodulesModal();
        } catch (e) {
          window.OpenVCS?.notify?.(`Submodule list failed: ${String(e || '').trim() || 'unknown error'}`);
        }
      },
      'submodules-update-all': async () => {
        try {
          await callSubmodule('git.submodule.update', { init: true, recursive: true, remote: false, paths: [] });
          window.OpenVCS?.notify?.('Updated submodules');
          window.dispatchEvent(new CustomEvent('app:status-updated'));
        } catch (e) {
          window.OpenVCS?.notify?.(`Submodule update failed: ${String(e || '').trim() || 'unknown error'}`);
        }
      },
      'submodules-sync-all': async () => {
        try {
          await callSubmodule('git.submodule.sync', { recursive: true, paths: [] });
          window.OpenVCS?.notify?.('Synced submodule remotes');
          window.dispatchEvent(new CustomEvent('app:status-updated'));
        } catch (e) {
          window.OpenVCS?.notify?.(`Submodule sync failed: ${String(e || '').trim() || 'unknown error'}`);
        }
      },
      'submodules-add': async () => {
        const url = String(window.prompt('Submodule URL', '') || '').trim();
        if (!url) return;
        const submodulePath = String(window.prompt('Submodule path (relative to repo root)', '') || '').trim();
        if (!submodulePath) return;
        try {
          await callSubmodule('git.submodule.add', { url, submodule_path: submodulePath });
          window.OpenVCS?.notify?.('Submodule added');
          window.dispatchEvent(new CustomEvent('app:status-updated'));
        } catch (e) {
          window.OpenVCS?.notify?.(`Submodule add failed: ${String(e || '').trim() || 'unknown error'}`);
        }
      },
      'submodule-update-path': async (payload) => {
        const file = payload?.file || null;
        const path = String(file?.path || payload?.clickedPath || '').trim();
        const status = String(file?.status || '').toUpperCase();
        if (!path || status !== 'S') return;
        try {
          await callSubmodule('git.submodule.update', { init: true, recursive: true, remote: false, paths: [path] });
          window.OpenVCS?.notify?.(`Updated submodule ${path}`);
          window.dispatchEvent(new CustomEvent('app:status-updated'));
        } catch (e) {
          window.OpenVCS?.notify?.(`Submodule update failed: ${String(e || '').trim() || 'unknown error'}`);
        }
      },
      'submodule-sync-path': async (payload) => {
        const file = payload?.file || null;
        const path = String(file?.path || payload?.clickedPath || '').trim();
        const status = String(file?.status || '').toUpperCase();
        if (!path || status !== 'S') return;
        try {
          await callSubmodule('git.submodule.sync', { recursive: true, paths: [path] });
          window.OpenVCS?.notify?.(`Synced submodule ${path}`);
        } catch (e) {
          window.OpenVCS?.notify?.(`Submodule sync failed: ${String(e || '').trim() || 'unknown error'}`);
        }
      },
      'submodule-remove-path': async (payload) => {
        const file = payload?.file || null;
        const path = String(file?.path || payload?.clickedPath || '').trim();
        const status = String(file?.status || '').toUpperCase();
        if (!path || status !== 'S') return;
        const ok = window.confirm(`Remove submodule ${path}? This removes mapping and stages deletion.`);
        if (!ok) return;
        try {
          await callSubmodule('git.submodule.remove', { submodule_path: path, force: false });
          window.OpenVCS?.notify?.(`Removed submodule ${path}`);
          window.dispatchEvent(new CustomEvent('app:status-updated'));
        } catch (e) {
          window.OpenVCS?.notify?.(`Submodule remove failed: ${String(e || '').trim() || 'unknown error'}`);
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
    // Also register the menubar menu via the plugin registration API as a
    // fallback in case the global `addMenubarMenu` helper is not present in
    // the host runtime. This avoids the LFS menu silently not appearing.
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
    refreshLocks();
  });
  window.addEventListener('app:repo-selected', () => {
    closeLfsLocksModal();
    closeSubmodulesModal();
    refreshLfsAvailability();
    refreshLocks();
  });
  window.addEventListener('app:repo-will-switch', () => {
    closeLfsLocksModal();
    closeSubmodulesModal();
  });
  document.addEventListener('contextmenu', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const row = target.closest('li.row[data-path]');
    lastContextPath = row ? normalizePath(row.getAttribute('data-path') || '') : '';
    setTimeout(updateContextMenuLabel, 0);
  }, { capture: true });
  refreshLfsAvailability();
  refreshLocks();
} catch (e) {
  // Plugin UI contributions are best-effort; ignore failures.
  void e;
}
