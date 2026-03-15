#!/usr/bin/env node
// Copyright © 2025-2026 OpenVCS Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PROTOCOL_VERSION = 1;

let _nextSessionId = 1;
const sessions = new Map();

let _buffer = Buffer.alloc(0);
let _processing = Promise.resolve();

process.stdin.on('data', (chunk) => {
  _buffer = Buffer.concat([_buffer, chunk]);
  consumeFrames();
});

process.stdin.on('error', () => {
  process.exit(1);
});

/** Writes one framed JSON-RPC payload to stdout. */
function send(value) {
  const payload = Buffer.from(JSON.stringify(value), 'utf8');
  const header = Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`, 'utf8');
  process.stdout.write(header);
  process.stdout.write(payload);
}

/** Emits a JSON-RPC success response. */
function sendResult(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

/** Emits a JSON-RPC error response. */
function sendError(id, code, message, data = undefined) {
  send({
    jsonrpc: '2.0',
    id,
    error: {
      code,
      message,
      ...(data == null ? {} : { data }),
    },
  });
}

/** Emits a notification that carries a VCS event payload. */
function emitVcsEvent(sessionId, requestId, event) {
  send({
    jsonrpc: '2.0',
    method: 'vcs.event',
    params: {
      session_id: sessionId,
      request_id: requestId,
      event,
    },
  });
}

/** Converts operation failures into host-understood plugin error payloads. */
function pluginError(code, message) {
  return {
    code: -32001,
    message,
    data: {
      code,
      message,
    },
  };
}

/** Parses framed messages from stdin and schedules them sequentially. */
function consumeFrames() {
  while (true) {
    const marker = _buffer.indexOf('\r\n\r\n');
    if (marker < 0) return;
    const header = _buffer.subarray(0, marker).toString('utf8');
    const lines = header.split(/\r?\n/g);
    let contentLength = 0;
    for (const line of lines) {
      const idx = line.indexOf(':');
      if (idx < 0) continue;
      const name = line.slice(0, idx).trim().toLowerCase();
      if (name !== 'content-length') continue;
      contentLength = Number(line.slice(idx + 1).trim()) || 0;
    }
    const total = marker + 4 + contentLength;
    if (_buffer.length < total) return;

    const payload = _buffer.subarray(marker + 4, total).toString('utf8');
    _buffer = _buffer.subarray(total);

    let message;
    try {
      message = JSON.parse(payload);
    } catch {
      continue;
    }

    _processing = _processing
      .then(() => handleMessage(message))
      .catch((err) => {
        const msg = String(err || 'unknown plugin processing error');
        send({
          jsonrpc: '2.0',
          method: 'host.log',
          params: {
            level: 'error',
            target: 'openvcs.git.plugin',
            message: msg,
          },
        });
      });
  }
}

/** Resolves session metadata or throws if unknown. */
function requireSession(sessionId) {
  const session = sessions.get(String(sessionId || ''));
  if (!session) {
    throw pluginError('vcs-invalid-session', `unknown session '${sessionId}'`);
  }
  return session;
}

/** Executes a git command and returns stdout/stderr/status. */
function runGit(args, cwd, opts = {}) {
  const result = spawnSync('git', args, {
    cwd,
    input: typeof opts.stdin === 'string' ? opts.stdin : undefined,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    status: typeof result.status === 'number' ? result.status : 1,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
  };
}

/** Executes a git command and throws pluginError when it fails. */
function runGitChecked(args, cwd, errorCode, requestId = null, sessionId = null, eventPhase = null, opts = {}) {
  if (eventPhase && sessionId) {
    emitVcsEvent(sessionId, requestId, {
      type: 'progress',
      phase: eventPhase,
      detail: `running: git ${args.join(' ')}`,
    });
  }
  const out = runGit(args, cwd, opts);
  if (out.status !== 0) {
    const message = out.stderr.trim() || out.stdout.trim() || `git exited with code ${out.status}`;
    throw pluginError(errorCode, message);
  }
  return out;
}

/** Returns whether merge is in progress for a session. */
function isMergeInProgress(session) {
  const mergeHeadPath = join(session.path, '.git', 'MERGE_HEAD');
  return existsSync(mergeHeadPath);
}

/** Parses `git status --porcelain=1 --branch -z -uall` into status summary/payload. */
function parseStatus(cwd) {
  const output = runGitChecked(['status', '--porcelain=1', '--branch', '-z', '-uall'], cwd, 'git-status-failed').stdout;
  const records = output.split('\0').filter(Boolean);

  let ahead = 0;
  let behind = 0;
  const files = [];
  const summary = { untracked: 0, modified: 0, staged: 0, conflicted: 0 };

  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    if (record.startsWith('## ')) {
      const aheadMatch = record.match(/ahead\s+(\d+)/);
      const behindMatch = record.match(/behind\s+(\d+)/);
      ahead = aheadMatch ? Number(aheadMatch[1]) : 0;
      behind = behindMatch ? Number(behindMatch[1]) : 0;
      continue;
    }

    if (record.length < 4) continue;
    const x = record[0];
    const y = record[1];
    const payloadPath = record.slice(3);
    const renamedOrCopied = x === 'R' || x === 'C' || y === 'R' || y === 'C';
    const path = payloadPath;
    const oldPath = renamedOrCopied ? records[i + 1] || null : null;
    if (renamedOrCopied && i + 1 < records.length) {
      i += 1;
    }
    const staged = x !== ' ' && x !== '?';

    if (x === '?' || y === '?') {
      summary.untracked += 1;
    } else if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) {
      summary.conflicted += 1;
    } else {
      if (staged) summary.staged += 1;
      if (y !== ' ') summary.modified += 1;
    }

    files.push({
      path,
      old_path: oldPath,
      status: `${x}${y}`.trim() || 'M',
      staged,
      resolved_conflict: false,
      hunks: [],
    });
  }

  return {
    summary,
    payload: {
      files,
      ahead,
      behind,
    },
  };
}

/** Parses commit list output into commit objects. */
function parseCommits(raw) {
  const records = raw.split('\u001e').map((v) => v.trim()).filter(Boolean);
  return records.map((record) => {
    const [id, msg, author, meta] = record.split('\u001f');
    return {
      id: String(id || ''),
      msg: String(msg || ''),
      author: String(author || ''),
      meta: String(meta || ''),
    };
  });
}

/** Handles one JSON-RPC request object. */
async function handleMessage(message) {
  const id = message?.id;
  const method = String(message?.method || '').trim();
  const params = message?.params && typeof message.params === 'object' ? message.params : {};
  if (!method || (typeof id !== 'number' && typeof id !== 'string')) {
    return;
  }

  const requestId = id;

  try {
    switch (method) {
      case 'plugin.initialize': {
        sendResult(id, {
          protocol_version: PROTOCOL_VERSION,
          implements: { plugin: true, vcs: true },
        });
        return;
      }
      case 'plugin.init':
      case 'plugin.deinit':
      case 'plugin.handle_action':
      case 'plugin.settings.on_apply':
      case 'plugin.settings.on_reset': {
        sendResult(id, null);
        return;
      }
      case 'plugin.get_menus': {
        sendResult(id, []);
        return;
      }
      case 'plugin.settings.defaults': {
        sendResult(id, []);
        return;
      }
      case 'plugin.settings.on_load':
      case 'plugin.settings.on_save': {
        sendResult(id, Array.isArray(params.values) ? params.values : []);
        return;
      }

      case 'vcs.get_caps': {
        sendResult(id, {
          commits: true,
          branches: true,
          tags: true,
          staging: true,
          push_pull: true,
          fast_forward: true,
        });
        return;
      }
      case 'vcs.open': {
        const repoPath = String(params.path || '').trim();
        if (!repoPath) throw pluginError('vcs-open-invalid-path', 'path is required');
        runGitChecked(['rev-parse', '--git-dir'], repoPath, 'vcs-open-not-repository');
        const sessionId = String(_nextSessionId++);
        sessions.set(sessionId, { path: repoPath });
        sendResult(id, { session_id: sessionId });
        return;
      }
      case 'vcs.close': {
        sessions.delete(String(params.session_id || ''));
        sendResult(id, null);
        return;
      }
      case 'vcs.clone_repo': {
        const url = String(params.url || '').trim();
        const dest = String(params.dest || '').trim();
        if (!url || !dest) throw pluginError('vcs-clone-invalid-args', 'url and dest are required');
        const out = runGitChecked(['clone', url, dest], process.cwd(), 'vcs-clone-failed', requestId, null, null);
        const lines = `${out.stdout}\n${out.stderr}`.split(/\r?\n/g).map((v) => v.trim()).filter(Boolean);
        for (const line of lines) {
          send({
            jsonrpc: '2.0',
            method: 'host.log',
            params: {
              level: 'info',
              target: 'openvcs.git.plugin',
              message: line,
            },
          });
        }
        sendResult(id, null);
        return;
      }
    }

    const session = requireSession(params.session_id);
    const cwd = session.path;

    switch (method) {
      case 'vcs.get_workdir': {
        sendResult(id, cwd);
        return;
      }
      case 'vcs.get_current_branch': {
        const branch = runGitChecked(['rev-parse', '--abbrev-ref', 'HEAD'], cwd, 'vcs-current-branch-failed').stdout.trim();
        sendResult(id, branch === 'HEAD' ? null : branch);
        return;
      }
      case 'vcs.list_branches': {
        const raw = runGitChecked(
          ['for-each-ref', '--format=%(refname:short)\t%(refname)\t%(HEAD)', 'refs/heads', 'refs/remotes'],
          cwd,
          'vcs-list-branches-failed'
        ).stdout;
        const lines = raw.split(/\r?\n/g).map((v) => v.trim()).filter(Boolean);
        const branches = lines.map((line) => {
          const [name, fullRef, headMark] = line.split('\t');
          const isRemote = String(fullRef || '').startsWith('refs/remotes/');
          const remote = isRemote ? String(name || '').split('/')[0] : null;
          return {
            name,
            full_ref: fullRef,
            kind: isRemote ? { type: 'Remote', remote } : { type: 'Local' },
            current: String(headMark || '').trim() === '*',
          };
        });
        sendResult(id, branches);
        return;
      }
      case 'vcs.list_local_branches': {
        const raw = runGitChecked(['for-each-ref', '--format=%(refname:short)', 'refs/heads'], cwd, 'vcs-list-local-branches-failed').stdout;
        sendResult(id, raw.split(/\r?\n/g).map((v) => v.trim()).filter(Boolean));
        return;
      }
      case 'vcs.create_branch': {
        runGitChecked(['branch', String(params.name || '')], cwd, 'vcs-create-branch-failed');
        if (params.checkout === true) {
          runGitChecked(['checkout', String(params.name || '')], cwd, 'vcs-checkout-branch-failed');
        }
        sendResult(id, null);
        return;
      }
      case 'vcs.checkout_branch': {
        runGitChecked(['checkout', String(params.name || '')], cwd, 'vcs-checkout-branch-failed');
        sendResult(id, null);
        return;
      }
      case 'vcs.ensure_remote': {
        const name = String(params.name || '').trim();
        const url = String(params.url || '').trim();
        if (!name || !url) throw pluginError('vcs-ensure-remote-invalid', 'name and url are required');
        const probe = runGit(['remote', 'get-url', name], cwd);
        if (probe.status === 0) {
          runGitChecked(['remote', 'set-url', name, url], cwd, 'vcs-set-remote-url-failed');
        } else {
          runGitChecked(['remote', 'add', name, url], cwd, 'vcs-add-remote-failed');
        }
        sendResult(id, null);
        return;
      }
      case 'vcs.list_remotes': {
        const raw = runGitChecked(['remote', '-v'], cwd, 'vcs-list-remotes-failed').stdout;
        const map = new Map();
        for (const line of raw.split(/\r?\n/g)) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          const m = trimmed.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
          if (!m) continue;
          map.set(m[1], m[2]);
        }
        sendResult(id, Array.from(map.entries()).map(([name, url]) => ({ name, url })));
        return;
      }
      case 'vcs.remove_remote': {
        runGitChecked(['remote', 'remove', String(params.name || '')], cwd, 'vcs-remove-remote-failed');
        sendResult(id, null);
        return;
      }
      case 'vcs.fetch': {
        runGitChecked(
          ['fetch', String(params.remote || ''), String(params.refspec || '')],
          cwd,
          'vcs-fetch-failed',
          requestId,
          String(params.session_id || ''),
          'fetch'
        );
        sendResult(id, null);
        return;
      }
      case 'vcs.fetch_with_options': {
        const args = ['fetch'];
        if (params?.opts?.prune === true) args.push('--prune');
        args.push(String(params.remote || ''));
        args.push(String(params.refspec || ''));
        runGitChecked(args, cwd, 'vcs-fetch-failed', requestId, String(params.session_id || ''), 'fetch');
        sendResult(id, null);
        return;
      }
      case 'vcs.push': {
        runGitChecked(
          ['push', String(params.remote || ''), String(params.refspec || '')],
          cwd,
          'vcs-push-failed',
          requestId,
          String(params.session_id || ''),
          'push'
        );
        sendResult(id, null);
        return;
      }
      case 'vcs.pull_ff_only': {
        runGitChecked(
          ['pull', '--ff-only', String(params.remote || ''), String(params.branch || '')],
          cwd,
          'vcs-pull-failed',
          requestId,
          String(params.session_id || ''),
          'pull'
        );
        sendResult(id, null);
        return;
      }
      case 'vcs.commit': {
        const paths = Array.isArray(params.paths) ? params.paths.map((v) => String(v || '')).filter(Boolean) : [];
        if (paths.length) {
          runGitChecked(['add', '--', ...paths], cwd, 'vcs-add-paths-failed');
        }
        runGitChecked(
          [
            '-c',
            `user.name=${String(params.name || '')}`,
            '-c',
            `user.email=${String(params.email || '')}`,
            'commit',
            '-m',
            String(params.message || ''),
          ],
          cwd,
          'vcs-commit-failed'
        );
        const commitId = runGitChecked(['rev-parse', 'HEAD'], cwd, 'vcs-rev-parse-failed').stdout.trim();
        sendResult(id, commitId);
        return;
      }
      case 'vcs.commit_index': {
        runGitChecked(
          [
            '-c',
            `user.name=${String(params.name || '')}`,
            '-c',
            `user.email=${String(params.email || '')}`,
            'commit',
            '-m',
            String(params.message || ''),
          ],
          cwd,
          'vcs-commit-index-failed'
        );
        const commitId = runGitChecked(['rev-parse', 'HEAD'], cwd, 'vcs-rev-parse-failed').stdout.trim();
        sendResult(id, commitId);
        return;
      }
      case 'vcs.get_status_summary': {
        const status = parseStatus(cwd);
        sendResult(id, status.summary);
        return;
      }
      case 'vcs.get_status_payload': {
        const status = parseStatus(cwd);
        sendResult(id, status.payload);
        return;
      }
      case 'vcs.list_commits': {
        const query = params.query && typeof params.query === 'object' ? params.query : {};
        const args = [
          'log',
          `--skip=${Number(query.skip || 0)}`,
          `--max-count=${Number(query.limit || 200)}`,
          '--pretty=format:%H%x1f%s%x1f%an%x1f%ad%x1e',
          '--date=iso',
        ];
        if (query.topo_order === true) args.push('--topo-order');
        if (query.include_merges !== true) args.push('--no-merges');
        if (query.author_contains) args.push(`--author=${String(query.author_contains)}`);
        if (query.since_utc) args.push(`--since=${String(query.since_utc)}`);
        if (query.until_utc) args.push(`--until=${String(query.until_utc)}`);
        args.push(String(query.rev || 'HEAD'));
        if (query.path) {
          args.push('--');
          args.push(String(query.path));
        }
        const raw = runGitChecked(args, cwd, 'vcs-log-failed').stdout;
        sendResult(id, parseCommits(raw));
        return;
      }
      case 'vcs.diff_file': {
        const raw = runGitChecked(['diff', '--', String(params.path || '')], cwd, 'vcs-diff-file-failed').stdout;
        sendResult(id, raw.split(/\r?\n/g));
        return;
      }
      case 'vcs.diff_commit': {
        const raw = runGitChecked(['show', '--format=', '--patch', String(params.rev || '')], cwd, 'vcs-diff-commit-failed').stdout;
        sendResult(id, raw.split(/\r?\n/g));
        return;
      }
      case 'vcs.get_conflict_details': {
        const path = String(params.path || '');
        sendResult(id, {
          path,
          ours: null,
          theirs: null,
          base: null,
          binary: false,
          lfs_pointer: false,
        });
        return;
      }
      case 'vcs.checkout_conflict_side': {
        const side = String(params.side || '').toLowerCase() === 'theirs' ? '--theirs' : '--ours';
        runGitChecked(['checkout', side, '--', String(params.path || '')], cwd, 'vcs-checkout-conflict-side-failed');
        sendResult(id, null);
        return;
      }
      case 'vcs.write_merge_result': {
        const path = String(params.path || '').trim();
        const contentB64 = String(params.content_b64 || '');
        const abs = join(cwd, path);
        const bytes = Buffer.from(contentB64, 'base64');
        writeFileSync(abs, bytes);
        sendResult(id, null);
        return;
      }
      case 'vcs.stage_patch': {
        runGitChecked(['apply', '--cached', '--unidiff-zero', '-'], cwd, 'vcs-stage-patch-failed', null, null, null, {
          stdin: String(params.patch || ''),
        });
        sendResult(id, null);
        return;
      }
      case 'vcs.discard_paths': {
        const paths = Array.isArray(params.paths) ? params.paths.map((v) => String(v || '')).filter(Boolean) : [];
        if (paths.length) runGitChecked(['checkout', '--', ...paths], cwd, 'vcs-discard-paths-failed');
        sendResult(id, null);
        return;
      }
      case 'vcs.apply_reverse_patch': {
        const out = runGit(['apply', '-R', '--unidiff-zero', '-'], cwd, { stdin: String(params.patch || '') });
        if (out.status !== 0) throw pluginError('vcs-apply-reverse-patch-failed', out.stderr.trim() || out.stdout.trim());
        sendResult(id, null);
        return;
      }
      case 'vcs.delete_branch': {
        runGitChecked(['branch', params.force ? '-D' : '-d', String(params.name || '')], cwd, 'vcs-delete-branch-failed');
        sendResult(id, null);
        return;
      }
      case 'vcs.rename_branch': {
        runGitChecked(['branch', '-m', String(params.old || ''), String(params.new || '')], cwd, 'vcs-rename-branch-failed');
        sendResult(id, null);
        return;
      }
      case 'vcs.merge_into_current': {
        const args = ['merge', String(params.name || '')];
        if (typeof params.message === 'string' && params.message.trim()) {
          args.push('-m');
          args.push(params.message.trim());
        }
        runGitChecked(args, cwd, 'vcs-merge-failed');
        sendResult(id, null);
        return;
      }
      case 'vcs.merge_abort': {
        runGitChecked(['merge', '--abort'], cwd, 'vcs-merge-abort-failed');
        sendResult(id, null);
        return;
      }
      case 'vcs.merge_continue': {
        runGitChecked(['merge', '--continue'], cwd, 'vcs-merge-continue-failed');
        sendResult(id, null);
        return;
      }
      case 'vcs.is_merge_in_progress': {
        sendResult(id, isMergeInProgress(session));
        return;
      }
      case 'vcs.set_branch_upstream': {
        runGitChecked(
          ['branch', '--set-upstream-to', String(params.upstream || ''), String(params.branch || '')],
          cwd,
          'vcs-set-upstream-failed'
        );
        sendResult(id, null);
        return;
      }
      case 'vcs.get_branch_upstream': {
        const out = runGit(['rev-parse', '--abbrev-ref', `${String(params.branch || '')}@{upstream}`], cwd);
        sendResult(id, out.status === 0 ? out.stdout.trim() : null);
        return;
      }
      case 'vcs.hard_reset_head': {
        runGitChecked(['reset', '--hard', 'HEAD'], cwd, 'vcs-hard-reset-failed');
        sendResult(id, null);
        return;
      }
      case 'vcs.reset_soft_to': {
        runGitChecked(['reset', '--soft', String(params.rev || '')], cwd, 'vcs-reset-soft-failed');
        sendResult(id, null);
        return;
      }
      case 'vcs.get_identity': {
        const name = runGit(['config', '--get', 'user.name'], cwd).stdout.trim();
        const email = runGit(['config', '--get', 'user.email'], cwd).stdout.trim();
        if (!name && !email) {
          sendResult(id, null);
        } else {
          sendResult(id, { name, email });
        }
        return;
      }
      case 'vcs.set_identity_local': {
        runGitChecked(['config', 'user.name', String(params.name || '')], cwd, 'vcs-set-name-failed');
        runGitChecked(['config', 'user.email', String(params.email || '')], cwd, 'vcs-set-email-failed');
        sendResult(id, null);
        return;
      }
      case 'vcs.list_stashes': {
        const raw = runGitChecked(['stash', 'list', '--pretty=format:%gd%x1f%s%x1e'], cwd, 'vcs-stash-list-failed').stdout;
        const entries = raw
          .split('\u001e')
          .map((v) => v.trim())
          .filter(Boolean)
          .map((line) => {
            const [selector, msg] = line.split('\u001f');
            return { selector, msg, meta: '' };
          });
        sendResult(id, entries);
        return;
      }
      case 'vcs.stash_push': {
        const args = ['stash', 'push'];
        if (params.include_untracked === true) args.push('--include-untracked');
        if (typeof params.message === 'string' && params.message.trim()) {
          args.push('-m');
          args.push(params.message.trim());
        }
        runGitChecked(args, cwd, 'vcs-stash-push-failed');
        const selector = runGitChecked(['stash', 'list', '-n', '1', '--pretty=format:%gd'], cwd, 'vcs-stash-push-failed').stdout.trim();
        sendResult(id, selector);
        return;
      }
      case 'vcs.stash_apply': {
        runGitChecked(['stash', 'apply', String(params.selector || '')], cwd, 'vcs-stash-apply-failed');
        sendResult(id, null);
        return;
      }
      case 'vcs.stash_pop': {
        runGitChecked(['stash', 'pop', String(params.selector || '')], cwd, 'vcs-stash-pop-failed');
        sendResult(id, null);
        return;
      }
      case 'vcs.stash_drop': {
        runGitChecked(['stash', 'drop', String(params.selector || '')], cwd, 'vcs-stash-drop-failed');
        sendResult(id, null);
        return;
      }
      case 'vcs.stash_show': {
        const diff = runGitChecked(['stash', 'show', '-p', String(params.selector || '')], cwd, 'vcs-stash-show-failed').stdout;
        sendResult(id, diff);
        return;
      }
      case 'vcs.cherry_pick': {
        runGitChecked(['cherry-pick', String(params.commit || '')], cwd, 'vcs-cherry-pick-failed');
        sendResult(id, null);
        return;
      }
      case 'vcs.revert_commit': {
        const args = ['revert'];
        if (params.no_edit === true) args.push('--no-edit');
        args.push(String(params.commit || ''));
        runGitChecked(args, cwd, 'vcs-revert-failed');
        sendResult(id, null);
        return;
      }
      default:
        throw pluginError('rpc-method-not-found', `method '${method}' is not implemented`);
    }
  } catch (error) {
    if (error && typeof error === 'object' && Number(error.code) === -32001) {
      sendError(id, error.code, error.message, error.data);
      return;
    }
    const message = String(error?.message || error || 'unknown error');
    sendError(id, -32002, message, { code: 'plugin-internal-error', message });
  }
}
