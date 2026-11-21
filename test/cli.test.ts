import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { parseCliArgs } from '../src/args.ts';
import { loadSong } from '../src/load.ts';
import { barTime } from '../src/sync.ts';
import { parseSyncFile, samePath } from '../src/syncFile.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const DEMO = fileURLToPath(new URL('../examples/demo-riff.txt', import.meta.url));

function run(...args: string[]) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

const hasFfmpeg = !spawnSync('ffmpeg', ['-version']).error;

test('args: a negative value after an option is that option\'s value', () => {
  assert.equal(parseCliArgs(['render', 'a.txt', '--audio-start', '-1.548']).values['audio-start'], '-1.548');
  assert.equal(parseCliArgs(['render', 'a.txt', '--audio-start', '-0:01.5']).values['audio-start'], '-0:01.5');
  assert.equal(parseCliArgs(['frame', 'a.txt', '--at', '-.5']).values.at, '-.5');
  assert.equal(parseCliArgs(['render', 'a.txt', '-s', '-50']).values.speed, '-50');
  // The "=" form keeps working, and so do positionals after the value.
  const r = parseCliArgs(['render', '--audio-start=-2', 'a.txt']);
  assert.equal(r.values['audio-start'], '-2');
  assert.deepEqual(r.positionals, ['render', 'a.txt']);
});

test('args: an option followed by another option is still an error', () => {
  assert.throws(() => parseCliArgs(['render', 'a.txt', '--audio-start', '--no-audio']), /--audio-start/);
  assert.throws(() => parseCliArgs(['render', 'a.txt', '--bogus']), /Unknown option '--bogus'/);
});

test('cli: a negative --audio-start with a space works', () => {
  const r = run('info', DEMO, '--audio', 'song.mp3', '--audio-start', '-0:01.548');
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /bar 1 at -1\.548s/);
});

test('cli: bad options give a one-line error, not a stack trace', () => {
  for (const args of [['info', DEMO, '--bogus'], ['info', DEMO, '--audio', 'a.mp3', '--audio-start', 'soon']]) {
    const r = run(...args);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /^Error: /);
    assert.doesNotMatch(r.stderr, /\n\s+at /, 'no stack trace');
  }
});

test('cli: number options are checked up front, with the option and value in the error', () => {
  const cases: [string[], RegExp][] = [
    [['render', DEMO, '--fps', 'abc'], /^Error: --fps must be a number above 0, got "abc"/],
    [['render', DEMO, '--fps', '0'], /^Error: --fps must be a number above 0, got "0"/],
    [['render', DEMO, '--zoom', '0'], /^Error: --zoom must be a number above 0, got "0"/],
    [['render', DEMO, '--zoom', ''], /^Error: --zoom must be a number above 0, got ""/],
    [['render', DEMO, '--count-in', '1.5'], /^Error: --count-in must be a whole number of 0 or more, got "1\.5"/],
    [['render', DEMO, '--count-in', '-1'], /^Error: --count-in must be a whole number of 0 or more, got "-1"/],
    [['render', DEMO, '--crf', '60'], /^Error: --crf must be a number from 0 to 51, got "60"/],
    [['render', DEMO, '--workers', '0'], /^Error: --workers must be a whole number of 1 or more, got "0"/],
    [['info', DEMO, '--track', 'lead'], /^Error: --track must be a whole number of 0 or more, got "lead"/],
    [['frame', DEMO, '--at', 'abc'], /^Error: --at: Invalid time "abc"/],
    [['frame', DEMO, '--at', '1', '--speed', '0'], /^Error: --speed values must be percentages between 1 and 200/],
  ];
  for (const [args, error] of cases) {
    const r = run(...args);
    assert.equal(r.code, 1, `${args.join(' ')} should fail`);
    assert.match(r.stderr, error);
  }
});

test('cli: --track past the last track says which tracks there are', () => {
  const lead = fileURLToPath(new URL('../examples/demo-lead.atex', import.meta.url));
  assert.match(run('info', lead, '--track', '7').stderr, /^Error: There is no track 7: this file has track 0 \(see "info"\)/);
});

test('cli: Ctrl-C during a render removes its unfinished files and keeps the previous video', { skip: !hasFfmpeg && 'needs ffmpeg' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'tabhop-'));
  try {
    // Windows can't send a real SIGINT to a child process, so the CLI raises it itself once the render is under way.
    const preload = join(dir, 'interrupt.mjs');
    writeFileSync(preload, `
      const write = process.stdout.write.bind(process.stdout);
      let sent = false;
      process.stdout.write = (chunk, ...rest) => {
        if (!sent && /frame \\d+\\//.test(String(chunk))) {
          sent = true;
          setImmediate(() => process.emit('SIGINT'));
        }
        return write(chunk, ...rest);
      };`);
    const out = join(dir, 'video.mp4');
    writeFileSync(out, 'the previous render');
    const r = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, CLI, 'render', DEMO, '--size', '640x360', '--workers', '2', '-o', out], { encoding: 'utf8' });
    assert.equal(r.status, 130, r.stderr);
    assert.match(r.stdout, /Stopped: removed the unfinished files/);
    assert.deepEqual(readdirSync(dir).sort(), ['interrupt.mjs', 'video.mp4']);
    assert.equal(readFileSync(out, 'utf8'), 'the previous render');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cli: a finished render replaces the previous video', { skip: !hasFfmpeg && 'needs ffmpeg' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'tabhop-'));
  try {
    const out = join(dir, 'video.mp4');
    writeFileSync(out, 'the previous render');
    const r = run('render', DEMO, '--bars', '1-1', '--size', '320x180', '-o', out);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(readdirSync(dir), ['video.mp4']);
    assert.equal(readFileSync(out).subarray(4, 8).toString(), 'ftyp');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cli: frame --at takes seconds or m:ss', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tabhop-'));
  try {
    const frame = (at: string) => {
      const out = join(dir, `${at.replace(':', '-')}.png`);
      const r = run('frame', DEMO, '--at', at, '--size', '320x180', '-o', out);
      assert.equal(r.code, 0, r.stderr);
      return readFileSync(out);
    };
    assert.ok(frame('0:01.5').equals(frame('1.5')), '0:01.5 is the same frame as 1.5');
    assert.ok(!frame('1.5').equals(frame('3')), 'a different time is a different frame');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cli: info reports a silent first bar and how to line up the audio', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tabhop-'));
  try {
    const tab = join(dir, 'lead-in.txt');
    writeFileSync(tab, 'bpm: 120\n' + ['e', 'B', 'G', 'D', 'A', 'E'].map((s) => `${s}|--------|${s === 'E' ? '-0------' : '--------'}|`).join('\n'));
    const plain = run('info', tab);
    assert.match(plain.stdout, /Lead-in: +bar 1 is silent, the first note is at 2 s/);
    assert.doesNotMatch(plain.stdout, /--audio-start/, 'no audio hint without audio');

    const withAudio = run('info', tab, '--audio', 'song.mp3');
    assert.match(withAudio.stdout, /If 0 s is where the first note sounds in the recording, use --audio-start=-2/);

    // A recording with an intro: the suggestion is relative to the given start.
    const intro = run('info', tab, '--audio', 'song.mp3', '--audio-start', '10');
    assert.match(intro.stdout, /If 10 s is where the first note sounds in the recording, use --audio-start=8/);

    // Already compensated with a negative start: no hint.
    assert.doesNotMatch(run('info', tab, '--audio', 'song.mp3', '--audio-start', '-2').stdout, /If .* is where/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cli: no lead-in line when the music starts right away', () => {
  assert.doesNotMatch(run('info', DEMO).stdout, /Lead-in/);
});

test('cli: --sync lines the tab up with the recording and reports the tempo correction', () => {
  // demo-riff is 100 bpm 4/4: bar 2 starts at 2.4 s in the tab.
  const r = run('info', DEMO, '--audio', 'song.mp3', '--sync', '1=1, 2=3');
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /bar 1 at 1\.000s/);
  assert.match(r.stdout, /Sync: +bar 1 = 0:01\.000, bar 2 = 0:03\.000/);
  assert.match(r.stdout, /bars 1-2: the recording is 20\.0% faster than the tab \(100 → 120 BPM\)/);
  assert.match(r.stdout, /Tempo: +120 BPM/);
});

test('cli: --sync needs audio and replaces --audio-start', () => {
  assert.match(run('info', DEMO, '--sync', '1=0').stderr, /^Error: --sync needs --audio <file>/);
  assert.match(run('info', DEMO, '--audio', 'a.mp3', '--sync', '1=0', '--audio-start', '2').stderr, /^Error: Use either --sync or --audio-start/);
  assert.match(run('info', DEMO, '--audio', 'a.mp3', '--sync', '1=0,99=10').stderr, /^Error: --sync: Song only has \d+ bars/);
});


/** A 16-bit mono WAV file. */
function wav(samples: Float32Array, rate: number): Buffer {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((v, i) => data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), i * 2));
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

/**
 * A 24-bar song at 120 BPM with crashes on most downbeats, and a "recording" of
 * it played 4% faster, starting 0.8 s in: noise bursts for the crashes, short
 * ticks for a hi-hat on every 8th.
 */
function drumSong(dir: string) {
  const bars = Array.from({ length: 24 }, (_, b) =>
    (b * 7) % 5 === 4 ? 'r.1' : (b * 3) % 7 === 1 ? '(CrashHighHit).4 r.4 r.4 (CrashHighHit).4' : '(CrashHighHit).4 r.4 r.2');
  const tab = join(dir, 'drums.atex');
  writeFileSync(tab, String.raw`\tempo 120 \track "Gtr" ` + bars.map(() => '0.6.1').join(' | ') +
    String.raw` \track "Drums" \instrument percussion \articulation defaults ` + bars.join(' | '));
  const truth = (t: number) => 0.8 + t / 1.04;
  const crashes = bars.flatMap((b, i) => (b === 'r.1' ? [] : b.includes('r.4 r.4') ? [2 * i, 2 * i + 1.5] : [2 * i]));
  const rate = 24000;
  const x = new Float32Array(Math.ceil((truth(48) + 1.5) * rate));
  let seed = 1;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) * 2 - 1;
  const hits = [...crashes.map((t) => ({ at: truth(t), level: 0.5, decay: 0.4 })),
    ...Array.from({ length: 96 }, (_, k) => ({ at: truth(k * 0.5) + 0.002, level: 0.15, decay: 0.015 }))];
  for (let i = 0; i < x.length; i++) {
    const t = i / rate;
    let a = 0.004;
    for (const h of hits) if (t >= h.at && t < h.at + 8 * h.decay) a += h.level * Math.exp(-(t - h.at) / h.decay);
    x[i] = Math.max(-1, Math.min(1, a * rnd()));
  }
  const audio = join(dir, 'drums.wav');
  writeFileSync(audio, wav(x, rate));
  return { tab, audio, truth };
}

test('cli: sync finds the sync points and render/info pick them up', { skip: !hasFfmpeg && 'needs ffmpeg' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'tabhop-'));
  try {
    const { tab, audio, truth } = drumSong(dir);
    const r = run('sync', tab, '--audio', audio);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /crash cymbals in the tab; \d+ line up/);
    assert.match(r.stdout, /bars 1-16 +4\.0% faster +14 of 14 cymbals heard/);
    assert.match(r.stdout, /Saved to .*drums\.atex\.sync\.txt/);

    const savedText = readFileSync(`${tab}.sync.txt`, 'utf8');
    assert.match(savedText, /^audio: drums\.wav$/m, 'a recording next to the tab is saved relative to it');
    const saved = parseSyncFile(savedText, `${tab}.sync.txt`);
    assert.ok(samePath(saved.audio!, audio));
    const song = loadSong(tab).song;
    for (const p of saved.points) {
      const t = barTime(song, p.bar);
      assert.ok(Math.abs(p.time - truth(t)) < 0.01, `bar ${p.bar}: ${p.time} vs ${truth(t)}`);
    }

    // info uses the file, with the recording it was made for.
    const info = run('info', tab);
    assert.match(info.stdout, /Audio: +.*drums\.wav \(bar 1 at 0\.8\d\ds\)/);
    assert.match(info.stdout, /Sync: .*\(from .*drums\.atex\.sync\.txt\)/);
    assert.doesNotMatch(run('info', tab, '--no-sync').stdout, /Sync:/);
    assert.match(run('info', tab, '--audio', join(dir, 'other.mp3')).stdout, /Not using .*sync\.txt: its sync points are for .*drums\.wav/);

    // Running again keeps the previous file.
    assert.equal(run('sync', tab, '--audio', audio, '--sync', '5=0:08.5').code, 0);
    assert.match(readFileSync(`${tab}.sync.txt`, 'utf8'), /^5 = 0:08\.500 +# pinned$/m);
    assert.ok(parseSyncFile(readFileSync(`${tab}.sync.txt.bak`, 'utf8')).points.length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cli: sync explains what it needs', () => {
  assert.match(run('sync', DEMO).stderr, /^Error: sync needs --audio <file>/);
  assert.match(run('sync', DEMO, '--audio', 'a.mp3', '--audio-start', '2').stderr, /^Error: sync works out where the audio starts/);
  // Checked before reading the recording, so the missing file doesn't matter.
  const r = run('sync', DEMO, '--audio', 'missing.mp3');
  assert.equal(r.code, 1);
  assert.match(r.stderr, /^Error: The tab has no crash cymbals/);
});

test('cli: saved sync points survive moving the folder or the recording', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tabhop-'));
  try {
    const tab = join(dir, 'riff.txt');
    writeFileSync(tab, readFileSync(DEMO, 'utf8'));
    const used = /Sync: +bar 1 = 0:02\.000 \(from .*riff\.txt\.sync\.txt\)/;

    // A relative path is relative to the sync file, not to where tabhop runs.
    writeFileSync(`${tab}.sync.txt`, 'audio: song.mp3\n1 = 0:02\n');
    const relative = run('info', tab);
    assert.match(relative.stdout, used);
    assert.ok(relative.stdout.includes(`Audio:    ${join(dir, 'song.mp3')} (bar 1 at 2.000s)`), relative.stdout);

    // The recording moved: a file with the same name gets the points, with a note.
    const gone = join(dir, 'gone', 'song.mp3');
    writeFileSync(`${tab}.sync.txt`, `audio: ${gone}\n1 = 0:02\n`);
    const moved = run('info', tab, '--audio', join(dir, 'song.mp3'));
    assert.match(moved.stdout, used);
    assert.ok(moved.stdout.includes(`${gone} isn't there anymore, so they're used for ${join(dir, 'song.mp3')} (same file name)`), moved.stdout);

    // A different recording doesn't.
    assert.match(run('info', tab, '--audio', join(dir, 'other.mp3')).stdout, /Not using .*sync\.txt: its sync points are for .*song\.mp3/);

    // Moved, and no --audio: says how to point to it.
    const missing = run('info', tab);
    assert.ok(missing.stdout.includes(`${gone} isn't there anymore. Pass the recording with --audio <file>`), missing.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cli: a broken sync file says how to get past it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tabhop-'));
  try {
    const tab = join(dir, 'riff.txt');
    writeFileSync(tab, readFileSync(DEMO, 'utf8'));
    writeFileSync(`${tab}.sync.txt`, 'audio: song.mp3\n2 = later\n');
    const r = run('info', tab);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /riff\.txt\.sync\.txt: Line 2: Invalid time "later"[\s\S]*--no-sync/);
    assert.equal(run('info', tab, '--no-sync').code, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
