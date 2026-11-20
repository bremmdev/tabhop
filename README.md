# tabhop

Turns a guitar tab into a scrolling practice video with a bouncing ball. Notes scroll towards a fixed ball that hops from note to note, leaving a comet trail. Each note fades to a dim cream outline once played. You can render slowed-down copies (90%, 80%, …) for practice, optionally with the original recording as a backing track.

There is no note detection: the video only shows what to play and when.

## Requirements

- Node.js ≥ 23.6 (runs the TypeScript sources directly)
- `ffmpeg` on PATH
- `npm install`

## Usage

```sh
# Render at full speed and at 90% / 80% / 70% (outputs to ./out)
node src/cli.ts render "my-song.gp5" --speed 100,90,80,70

# Only bars 9–16 (e.g. to practise the solo) at 75%
node src/cli.ts render "my-song.gp5" --bars 9-16 --speed 75

# Check what was parsed (tracks, tuning, tempo, first notes)
node src/cli.ts info "my-song.gp5"

# Preview a single frame at song time 12.5 s (fast way to check a tab)
node src/cli.ts frame "my-song.txt" --at 12.5

# Line a Guitar Pro file with drums up with a recording (see "Recordings that drift")
node src/cli.ts sync "my-song.gp5" --audio "song.mp3"

# Try it with the bundled examples
node src/cli.ts render examples/demo-riff.txt --speed 100,80
```

The files in `examples/` are generic exercises built from textbook patterns (power-chord progressions, the E minor pentatonic scale). They aren't transcriptions of any song.

| Option | Default | |
|---|---|---|
| `-s, --speed` | `100` | Comma-separated percentages; one video per speed |
| `-o, --out` | `./out` | Output directory, or a `.mp4` path for a single speed |
| `-t, --track` | first guitar | Track for multi-track Guitar Pro files (see `info`) |
| `-b, --bars` | all | Render a bar range, e.g. `17-32` |
| `--size` | `1920x1080` | e.g. `2304x1440` (16:10), `1280x720` |
| `--fps` | `60` | |
| `--zoom` | `1` | Horizontal spacing; raise it for fast/dense parts |
| `--note-shape` | `tile` | `tile`, `round`, `hex` or `outline` |
| `--count-in` | `1` | Bars of count-in before the first note |
| `--no-chords` | | Turn off automatic chord names |
| `--encoder` | `libx264` | e.g. `h264_nvenc` on NVIDIA GPUs |
| `--crf` | `18` | Quality (lower = better/larger) |
| `--workers` | auto | Parallel render threads |
| `--audio` | | Backing track (mp3, wav, flac, …) |
| `--audio-start` | `0` | Where bar 1 of the tab starts in the audio (`58.76` or `0:58.76`; negative if bar 1 is before the recording starts) |
| `--sync` | | Pin bars to times in the recording, e.g. `2=0.06,110=2:43.1`, for recordings that don't follow the tab's tempo (see below) |
| `--no-sync` | | Ignore the sync points saved by `sync` |
| `--no-audio` | | Ignore the audio set in the tab file |

## Backing track

```sh
node src/cli.ts render riff.txt --audio "song.mp3" --audio-start 0:58.76 --speed 100,80
```

Song time 0 (the start of bar 1 of the tab) plays from `--audio-start` in the recording. The count-in plays the audio just before it. Slowed-down videos time-stretch the audio without changing pitch. `--bars` keeps the audio aligned automatically.

Bar 1 is not always where the music starts. Many Guitar Pro files begin with an empty bar, and then the recording's first note belongs at the start of bar 2. Use a negative start for that, e.g. `--audio-start -1.548` (or `-0:01.548`). `info` and `render` point it out when a tab starts with silence and suggest the value.

### Recordings that drift

A single start time only works if the band plays exactly the tab's tempo. Real bands speed up and slow down, and transcriptions often round the tempo (155 BPM in the tab, 160 in the recording). The notes then drift further from the music as the song goes on.

Sync points pin bars to times in the recording instead. Between two points, the tab's timing is stretched to match. The video follows the band and the recording plays untouched.

#### Finding them automatically

If the tab has a drum track with crash cymbals (most full-band Guitar Pro files do), `sync` finds the points for you:

```sh
node src/cli.ts sync song.gp4 --audio song.mp3
```

It listens for crash cymbals in the recording, matches them to the crashes in the drum track, and saves the points next to the tab as `song.gp4.sync.txt`. `render`, `info` and `frame` then use that file whenever they play the same recording, so a plain `render song.gp4` comes out in sync. `--no-sync` ignores it.

The report says how far to trust each part of the song. The fit is made on half the cymbals and checked on the other half:

```
  bars 17-32    2.6% faster  19 of 20 cymbals heard  5 ms
  bars 113-128  3.9% faster  0 of 8 cymbals heard    64 ms  <- listen: the cymbals also fit 0.72 s later
```

- **ms** is how far the checked cymbals are from the nearest crash in the recording. Under about 30 ms looks and sounds right.
- **listen** marks parts to check by ear in the video. "Also fits … later" means the cymbals line up nearly as well shifted by a beat or so. "Few … heard" usually means the band plays that part differently from the tab, or the crashes are buried in the mix.
- A **run of cymbals** that isn't in the recording (a roll the drummer doesn't play, often at a break) is left out and reported, because bands often hold breaks longer than written.

To fix a part, find the right time by ear and pin it. The other points are fitted around it:

```sh
node src/cli.ts sync song.gp4 --audio song.mp3 --sync "110=2:43.12"
```

You can also edit the `.sync.txt` file directly. Running `sync` again keeps the old file as `.sync.txt.bak`.

It needs crashes in the tab and audible cymbals in the recording. Tabs without a drum track (ASCII tabs, guitar-only excerpts) can't be synced automatically: use `--audio-start`, or pick a few points by ear as below.

#### By hand

`--sync` takes the points on the command line:

```sh
node src/cli.ts render song.gp4 --audio song.mp3 --sync "2=0.06, 27.25=0:39.107, 110=2:43.12"
```

- Each point is `bar=time`. The time is in seconds or `m:ss` in the recording, and the bar counts from 1 as in `info`. A fraction is a position inside the bar: `27.25` is beat 2 of a 4/4 bar, `66.875` is beat 4½.
- Good sync points are moments you can hear clearly: the first chord, the drums coming in, a crash cymbal, a stop.
- Before the first point and after the last one, the nearest section's correction carries on. One point does the same as `--audio-start`.
- `info --sync ...` lists how much faster or slower the recording is than the tab in each section. A section that comes out at about 50% or 200% usually means a typo, or a tab written in half or double time.
- `--sync` replaces `--audio-start`, and works with `--bars` and slowed-down speeds.

For a text tab you can put the same settings in the header instead of passing flags:

```
audio: D:\MUSIX\song.mp3        # relative paths are relative to the tab file
audioStart: 58.762
```

The `bpm:` must match the recording, or the notes drift away from the music. Most recordings aren't exactly the BPM listed online (often they're half or double that figure).

## Input formats

**Guitar Pro (`.gp`, `.gp3`, `.gp4`, `.gp5`, `.gpx`) is recommended.** It stores exact rhythm, tempo changes, repeats, sections and techniques. Guitar Pro, MuseScore and TuxGuitar can all save in this format. MusicXML (`.musicxml`, `.xml`, `.mxl`) and alphaTex (`.atex`, `.alphatex`, `.tex`) also work.

**Not supported:** images, screenshots and PDFs of tabs, or any other file type. tabhop can't read notation from a picture. Copy the tab as text into a `.txt` file, or export it from Guitar Pro, MuseScore or TuxGuitar.

**ASCII tabs (`.txt`, `.tab`)** are supported, but plain-text tabs don't store rhythm, so timing is worked out from the spacing. Add a small header at the top:

```
title: Song Name
artist: Band
bpm: 120
time: 4/4
tuning: E A D G B E      # low → high, or: drop d, eb, d standard, drop c, open g ...

[Verse]
   E5          G5
PM--------|
e|----------------|----------------|
B|----------------|----------------|
G|----------------|----------------|
D|-2--------------|-5--------------|
A|-2--------------|-5--------------|
E|-0---0-0-0---0--|-3--------------|  x2
```

- **Timing (default `timing: bar`)**: each bar between `|` lines is one measure. Notes are placed by their column and snapped to 16th notes (`quantize: 16`; use `12` for triplet feels). Keep the spacing inside a bar even, e.g. 4 dashes per beat.
- **`grid: 4`** switches to grid timing: every 4 characters is one beat and bar lines don't affect timing. Use it for tabs with perfectly regular spacing.
- `bpm:` (or `tempo:`) / `time:` lines between systems change the tempo or time signature from that point on.
- Comments: a line starting with `#` or `//` is ignored, and so is ` # …` or ` // …` at the end of a header line. The `#` needs a space on both sides, so sharps (`C#`) and file names (`song#2.mp3`) still work.
- `[Section]` lines become section labels. A chord line directly above a system becomes chord names; without one, chord names are detected automatically.
- `x2` / `(x4)` after a system repeats it.
- `PM----` lines above or below a system mark palm mutes.
- Techniques: `h` hammer-on, `p` pull-off, `/ \ s` slide, `b` bend (`7b9` = whole step, `7b` = full, `7b9r7` = bend and release), `~` or `v` vibrato, `x` dead note, `<12>` or `[12]` harmonic, `t` tap.
- Tuning: `tuning:` takes note names from low to high, or one of `standard`, `drop d`, `eb` / `half step down`, `d standard`, `drop c`, `drop c#`, `open g`, `open d`, `bass`, `7 string`. Without a `tuning:` line, the string labels (`D|`, `A|`, …) are used, and otherwise standard tuning.
- 4- to 8-string tabs work. Without labels or a `tuning:` line, a 4- or 5-string tab is treated as bass (E A D G / B E A D G), and a 7- or 8-string tab as extended-range guitar.

Run `info` after writing a tab to check the timing. `frame --at <sec>` shows a single frame.

## How it looks

- Strings run from high e (top) to low E (bottom), as in tab.
- Notes are rounded tiles. Their colour shows the suggested fretting finger, gold = index, purple = middle, blue = ring, coral = pinky, soft grey = open string. Fingers come from the Guitar Pro file if it has them, otherwise from a simple "one finger per fret" hand-position guess.
- The strings are amber: the three plain strings are thin and pale, the three lowest (wound) strings are thicker and a little deeper in tone.
- Played notes turn into dark tiles with a dim cream outline, so what is still to come stands out. Notes held for a beat or longer are drawn as long bars (sustains) that empty from left to right while they ring. In the mini-map, played notes are solid cream.
- Faint amber sound waves flow across the background above the board.
- The ball leaves a fading comet trail along the path it just travelled.
- Badges: `H`/`P` hammer/pull (with slur), `S` slide, `T` tap, bend arrows with amount, wavy line = vibrato, `P.M.` span, `×` dead note, diamond = harmonic.
- The footer shows a mini-map of the whole song with progress.
- If the tuning isn't standard, it's shown in the top right under the BPM (e.g. "Eb Standard", "Drop D", or the string notes for other tunings).

## Copyright and your files

tabhop only converts files you give it. It doesn't include, download or look up any songs or recordings.

Tabs of existing songs and their recordings are usually protected by copyright: the composition belongs to the songwriter or publisher, and the recording to the label. You're responsible for having the right to use the tabs and audio you give it. Get permission before publishing or sharing videos made from someone else's music.

Keep your own song files in `tabs/`. That folder, and common audio formats, are in `.gitignore` so they're never committed.

tabhop is an independent project. It isn't affiliated with or endorsed by any guitar-learning app or tab site.

## Development

```sh
npm test           # parser / timing tests
npm run typecheck
```

Code map: `src/parsers/*` (tab → `Song`), `src/fingering.ts`, `src/chords.ts`, `src/layout.ts` (geometry + ball trajectory), `src/render/renderer.ts` (draws one frame), `src/video.ts` (parallel frame rendering → ffmpeg), `src/sync.ts` (re-timing to a recording), `src/audio.ts` + `src/autosync.ts` + `src/syncCommand.ts` (`tabhop sync`), `src/syncFile.ts` (the saved `.sync.txt`).
