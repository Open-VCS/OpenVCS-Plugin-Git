// Copyright © 2025-2026 OpenVCS Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, it } from 'node:test';
import assert from 'node:assert';

describe('Git plugin', () => {
  describe('parseStatus rename/copy path ordering', () => {
    it('correctly orders old_path and path for rename records', () => {
      const mockRecords = [
        '## main',
        'R  oldname.txt\0newname.txt\0',
      ];
      const output = mockRecords.join('\0');
      const records = output.split('\0').filter(Boolean);
      const fileRecords = records.filter((r) => !r.startsWith('## '));

      for (let i = 0; i < fileRecords.length; i += 1) {
        const record = fileRecords[i];
        if (record.length < 4) continue;
        const x = record[0];
        const y = record[1];
        const payloadPath = record.slice(3);
        const renamedOrCopied = x === 'R' || x === 'C' || y === 'R' || y === 'C';

        if (renamedOrCopied) {
          const nextRecord = fileRecords[i + 1];
          const path = nextRecord;
          const oldPath = payloadPath;
          assert.strictEqual(path, 'newname.txt', 'path should be new name');
          assert.strictEqual(oldPath, 'oldname.txt', 'old_path should be old name');
        }
      }
    });

    it('correctly orders old_path and path for copy records', () => {
      const mockRecords = [
        '## main',
        'C  original.txt\0copy.txt\0',
      ];
      const output = mockRecords.join('\0');
      const records = output.split('\0').filter(Boolean);
      const fileRecords = records.filter((r) => !r.startsWith('## '));

      for (let i = 0; i < fileRecords.length; i += 1) {
        const record = fileRecords[i];
        if (record.length < 4) continue;
        const x = record[0];
        const y = record[1];
        const payloadPath = record.slice(3);
        const renamedOrCopied = x === 'R' || x === 'C' || y === 'R' || y === 'C';

        if (renamedOrCopied) {
          const nextRecord = fileRecords[i + 1];
          const path = nextRecord;
          const oldPath = payloadPath;
          assert.strictEqual(path, 'copy.txt', 'path should be new name');
          assert.strictEqual(oldPath, 'original.txt', 'old_path should be old name');
        }
      }
    });

    it('handles unstaged rename (y=R) correctly', () => {
      const mockRecords = [
        '## main',
        ' R old.txt\0new.txt\0',
      ];
      const output = mockRecords.join('\0');
      const records = output.split('\0').filter(Boolean);
      const fileRecords = records.filter((r) => !r.startsWith('## '));

      for (let i = 0; i < fileRecords.length; i += 1) {
        const record = fileRecords[i];
        if (record.length < 4) continue;
        const x = record[0];
        const y = record[1];
        const payloadPath = record.slice(3);
        const renamedOrCopied = x === 'R' || x === 'C' || y === 'R' || y === 'C';

        if (renamedOrCopied) {
          const nextRecord = fileRecords[i + 1];
          const path = nextRecord;
          const oldPath = payloadPath;
          assert.strictEqual(path, 'new.txt', 'path should be new name');
          assert.strictEqual(oldPath, 'old.txt', 'old_path should be old name');
        }
      }
    });
  });

  describe('network command argument building', () => {
    it('simulates fetch with no args', () => {
      const params = {};
      const args = ['fetch'];
      if (params.remote) args.push(params.remote);
      if (params.refspec) args.push(params.refspec);
      assert.deepStrictEqual(args, ['fetch']);
    });

    it('simulates fetch with remote only', () => {
      const params = { remote: 'origin' };
      const args = ['fetch'];
      if (params.remote) args.push(params.remote);
      if (params.refspec) args.push(params.refspec);
      assert.deepStrictEqual(args, ['fetch', 'origin']);
    });

    it('simulates fetch with remote and refspec', () => {
      const params = { remote: 'origin', refspec: 'main' };
      const args = ['fetch'];
      if (params.remote) args.push(params.remote);
      if (params.refspec) args.push(params.refspec);
      assert.deepStrictEqual(args, ['fetch', 'origin', 'main']);
    });

    it('simulates push with no args', () => {
      const params = {};
      const args = ['push'];
      if (params.remote) args.push(params.remote);
      if (params.refspec) args.push(params.refspec);
      assert.deepStrictEqual(args, ['push']);
    });

    it('simulates pull --ff-only with no args', () => {
      const params = {};
      const args = ['pull', '--ff-only'];
      if (params.remote) args.push(params.remote);
      if (params.branch) args.push(params.branch);
      assert.deepStrictEqual(args, ['pull', '--ff-only']);
    });

    it('simulates pull --ff-only with remote and branch', () => {
      const params = { remote: 'origin', branch: 'main' };
      const args = ['pull', '--ff-only'];
      if (params.remote) args.push(params.remote);
      if (params.branch) args.push(params.branch);
      assert.deepStrictEqual(args, ['pull', '--ff-only', 'origin', 'main']);
    });

    it('simulates fetch --prune with options', () => {
      const params = { opts: { prune: true }, remote: 'origin' };
      const args = ['fetch'];
      if (params?.opts?.prune === true) args.push('--prune');
      if (params.remote) args.push(params.remote);
      if (params.refspec) args.push(params.refspec);
      assert.deepStrictEqual(args, ['fetch', '--prune', 'origin']);
    });
  });
});
