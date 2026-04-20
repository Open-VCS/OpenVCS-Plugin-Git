// Copyright © 2025-2026 OpenVCS Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  applySubmoduleStatusHints,
  buildCloneArgs,
  buildFetchArgs,
  buildPullFfOnlyArgs,
  buildPushArgs,
  buildSubmoduleUpdateArgs,
  parseStatusOutput,
} from '../src/plugin-helpers.js';

import { PluginDefinition, OnPluginStart } from '../src/plugin.js';
import { planDiscardPaths } from '../src/plugin-request-handler.js';

describe('Git plugin helpers', () => {
  describe('parseStatusOutput', () => {
    it('assigns old_path and path for staged rename records', () => {
      const status = parseStatusOutput('## main\0R  oldname.txt\0newname.txt\0');

      assert.deepStrictEqual(status.payload.files[0], {
        path: 'newname.txt',
        old_path: 'oldname.txt',
        status: 'R',
        staged: true,
        resolved_conflict: false,
        hunks: [],
      });
    });

    it('assigns old_path and path for copy records', () => {
      const status = parseStatusOutput('## main\0C  original.txt\0copy.txt\0');

      assert.deepStrictEqual(status.payload.files[0], {
        path: 'copy.txt',
        old_path: 'original.txt',
        status: 'C',
        staged: true,
        resolved_conflict: false,
        hunks: [],
      });
    });

    it('keeps rename ordering for unstaged rename records', () => {
      const status = parseStatusOutput('## main\0 R old.txt\0new.txt\0');

      assert.deepStrictEqual(status.payload.files[0], {
        path: 'new.txt',
        old_path: 'old.txt',
        status: 'R',
        staged: false,
        resolved_conflict: false,
        hunks: [],
      });
    });
  });

  describe('network command argument building', () => {
    it('builds fetch with no optional arguments', () => {
      assert.deepStrictEqual(buildFetchArgs({}), ['fetch']);
    });

    it('builds fetch with remote only', () => {
      assert.deepStrictEqual(buildFetchArgs({ remote: 'origin' }), [
        'fetch',
        'origin',
      ]);
    });

    it('builds fetch with remote and refspec', () => {
      assert.deepStrictEqual(
        buildFetchArgs({ remote: 'origin', refspec: 'main' }),
        ['fetch', 'origin', 'main'],
      );
    });

    it('builds fetch with prune enabled', () => {
      assert.deepStrictEqual(
        buildFetchArgs({ opts: { prune: true }, remote: 'origin' }),
        ['fetch', '--prune', 'origin'],
      );
    });

    it('builds clone with recursive submodules enabled', () => {
      assert.deepStrictEqual(buildCloneArgs({ url: 'https://example.com/repo.git', dest: 'repo' }), [
        'clone',
        '--recurse-submodules',
        'https://example.com/repo.git',
        'repo',
      ]);
    });

    it('builds push with no optional arguments', () => {
      assert.deepStrictEqual(buildPushArgs({}), ['push']);
    });

    it('builds pull --ff-only with no optional arguments', () => {
      assert.deepStrictEqual(buildPullFfOnlyArgs({}), ['pull', '--ff-only']);
    });

    it('builds pull --ff-only with remote and branch', () => {
      assert.deepStrictEqual(
        buildPullFfOnlyArgs({ remote: 'origin', branch: 'main' }),
        ['pull', '--ff-only', 'origin', 'main'],
      );
    });

    it('builds submodule update for one path', () => {
      assert.deepStrictEqual(buildSubmoduleUpdateArgs({ path: 'libs/example' }), [
        'submodule',
        'update',
        '--init',
        '--recursive',
        '--',
        'libs/example',
      ]);
    });

    it('builds submodule remote update recursively', () => {
      assert.deepStrictEqual(buildSubmoduleUpdateArgs({ remote: true }), [
        'submodule',
        'update',
        '--init',
        '--recursive',
        '--remote',
      ]);
    });
  });

  describe('submodule status hints', () => {
    it('marks known submodule paths distinctly in status payloads', () => {
      const parsed = parseStatusOutput('## main\0 M deps/example\0');
      const hinted = applySubmoduleStatusHints(parsed, ['deps/example']);

      assert.deepStrictEqual(hinted.payload.files[0], {
        path: 'deps/example',
        old_path: null,
        status: 'S',
        staged: false,
        resolved_conflict: false,
        hunks: [],
      });
    });
  });

  describe('discard path planning', () => {
    it('routes tracked files to restore and untracked files to clean', () => {
      const plan = planDiscardPaths(' M tracked.txt\0?? scratch.txt\0');

      assert.deepStrictEqual(plan, {
        restore: ['tracked.txt'],
        unstageThenRemove: [],
        clean: ['scratch.txt'],
      });
    });

    it('restores the old side of staged renames and removes the new side', () => {
      const plan = planDiscardPaths('R  old-name.txt\0new-name.txt\0');

      assert.deepStrictEqual(plan, {
        restore: ['old-name.txt'],
        unstageThenRemove: ['new-name.txt'],
        clean: ['new-name.txt'],
      });
    });

    it('cleans unstaged rename targets after restoring the original path', () => {
      const plan = planDiscardPaths(' R old-name.txt\0new-name.txt\0');

      assert.deepStrictEqual(plan, {
        restore: ['old-name.txt'],
        unstageThenRemove: [],
        clean: ['new-name.txt'],
      });
    });

    it('unstages and removes staged additions that do not exist in HEAD', () => {
      const plan = planDiscardPaths('A  added.txt\0');

      assert.deepStrictEqual(plan, {
        restore: [],
        unstageThenRemove: ['added.txt'],
        clean: ['added.txt'],
      });
    });

    it('unstages and removes staged copies that do not exist in HEAD', () => {
      const plan = planDiscardPaths('C  original.txt\0copy.txt\0');

      assert.deepStrictEqual(plan, {
        restore: [],
        unstageThenRemove: ['copy.txt'],
        clean: ['copy.txt'],
      });
    });
  });
});

describe('Git plugin exports', () => {
  describe('PluginDefinition', () => {
    it('is exported with the configured log target', () => {
      assert.ok(PluginDefinition, 'PluginDefinition is exported');
      assert.ok(PluginDefinition.logTarget, 'PluginDefinition has logTarget');
      assert.strictEqual(PluginDefinition.logTarget, 'openvcs.git.plugin');
    });

    it('registers vcs delegates during plugin startup', () => {
      OnPluginStart();

      const vcs = PluginDefinition.vcs;
      assert.ok(vcs, 'vcs delegates exist');
      assert.ok(vcs['vcs.open'], 'vcs.open delegate exists');
      assert.ok(vcs['vcs.close'], 'vcs.close delegate exists');
      assert.ok(vcs['vcs.get_caps'], 'vcs.get_caps delegate exists');
      assert.ok(vcs['vcs.clone_repo'], 'vcs.clone_repo delegate exists');
      assert.ok(vcs['vcs.get_workdir'], 'vcs.get_workdir delegate exists');
      assert.ok(vcs['vcs.get_current_branch'], 'vcs.get_current_branch delegate exists');
      assert.ok(vcs['vcs.list_branches'], 'vcs.list_branches delegate exists');
      assert.ok(vcs['vcs.list_local_branches'], 'vcs.list_local_branches delegate exists');
      assert.ok(vcs['vcs.create_branch'], 'vcs.create_branch delegate exists');
      assert.ok(vcs['vcs.checkout_branch'], 'vcs.checkout_branch delegate exists');
      assert.ok(vcs['vcs.fetch'], 'vcs.fetch delegate exists');
      assert.ok(vcs['vcs.push'], 'vcs.push delegate exists');
      assert.ok(vcs['vcs.pull_ff_only'], 'vcs.pull_ff_only delegate exists');
      assert.ok(vcs['vcs.commit'], 'vcs.commit delegate exists');
      assert.ok(vcs['vcs.get_status_summary'], 'vcs.get_status_summary delegate exists');
      assert.ok(vcs['vcs.get_status_payload'], 'vcs.get_status_payload delegate exists');
      assert.ok(vcs['vcs.list_commits'], 'vcs.list_commits delegate exists');
    });
  });

  describe('OnPluginStart', () => {
    it('is exported as a function', () => {
      assert.ok(OnPluginStart, 'OnPluginStart is exported');
      assert.strictEqual(typeof OnPluginStart, 'function', 'OnPluginStart is a function');
    });

    it('validates Git and attaches the delegate map', () => {
      OnPluginStart();
      assert.ok(PluginDefinition.vcs, 'PluginDefinition.vcs is populated at startup');
    });
  });
});
