import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { clock, formatSyncFile, parseSyncFile, samePath, syncFilePath } from '../src/syncFile.ts';

test('sync file: written and read back', () => {
  const points = [{ bar: 2, time: 0.062 }, { bar: 27.25, time: 39.107 }, { bar: 110, time: 163.12 }];
  const text = formatSyncFile('tabs/song.gp4', 'music/song.mp3', points, new Map([[110, 'check: after the break']]));
  assert.match(text, /^# Sync points for song\.gp4/);
  assert.match(text, /^110 = 2:43\.120 +# check: after the break$/m);
  const back = parseSyncFile(text);
  assert.deepEqual(back.points, points);
  assert.equal(back.audio, resolve('music/song.mp3'));
});

test('sync file: hand-written, with comments and in any order', () => {
  const f = parseSyncFile('# mine\naudio: D:\\Music\\song#2.mp3   # the remaster\n\n  110 = 2:43.1\n2=0.06 # first chord\r\n');
  assert.equal(f.audio, 'D:\\Music\\song#2.mp3');
  assert.deepEqual(f.points, [{ bar: 2, time: 0.06 }, { bar: 110, time: 163.1 }]);
  assert.equal(parseSyncFile('3 = 1').audio, undefined);
});

test('sync file: mistakes say which line', () => {
  assert.throws(() => parseSyncFile('audio: a.mp3\n2 = 0.1\nbar 3 at 2s'), /Line 3: expected "bar = time"/);
  assert.throws(() => parseSyncFile('2 = soon'), /Line 1: Invalid time "soon"/);
  assert.throws(() => parseSyncFile('# nothing\naudio: a.mp3'), /No sync points/);
  assert.throws(() => parseSyncFile('2 = 5\n4 = 3'), /out of order/);
});

test('sync file: names and helpers', () => {
  assert.equal(syncFilePath('in/song.gp4'), 'in/song.gp4.sync.txt');
  assert.equal(clock(163.12), '2:43.120');
  assert.equal(clock(-1.5), '-0:01.500');
  assert.ok(samePath('a/../b.mp3', 'b.mp3'));
  assert.equal(samePath('B.mp3', 'b.mp3'), process.platform === 'win32');
});
