// Copyright © 2025-2026 OpenVCS Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildFetchArgs,
  buildPullFfOnlyArgs,
  buildPushArgs,
  parseStatusOutput,
} from '../src/plugin-helpers.js';

import { PluginDefinition, OnPluginStart } from '../src/plugin.js';

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
  });
});

describe('Git plugin exports', () => {
  describe('PluginDefinition', () => {
    it('is exported and has vcs delegates', () => {
      assert.ok(PluginDefinition, 'PluginDefinition is exported');
      assert.ok(PluginDefinition.vcs, 'PluginDefinition has vcs delegates');
      assert.ok(PluginDefinition.logTarget, 'PluginDefinition has logTarget');
      assert.strictEqual(PluginDefinition.logTarget, 'openvcs.git.plugin');
    });

    it('has all required vcs delegate methods', () => {
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

    it('returns a promise when called', async () => {
      const result = OnPluginStart();
      assert.ok(result instanceof Promise, 'OnPluginStart returns a promise');
      await result;
    });

    it('validates Git is installed', async () => {
      await assert.rejects(
        async () => {
          const original = process.cwd;
          try {
            process.cwd = () => '/nonexistent';
            await OnPluginStart();
          } finally {
            process.cwd = original;
          }
        },
        { message: /Git/ },
        'Should throw when Git is not available',
      );
    });

    it('validates Git version is parseable', async () => {
      await OnPluginStart();
    });
  });
});
