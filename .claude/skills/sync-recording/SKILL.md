---
name: sync-recording
description: Lining a tab up with a recording in tabhop. Use when a rendered video and its backing track are out of sync, when choosing which of several tabs fits a recording, or when reading or fixing a `tabhop sync` report.
---

# Lining a tab up with a recording

The goal is a set of **sync points** (bar = time in the recording) that `render` uses so the notes land on the band. `tabhop sync` finds them from crash cymbals; your job is to feed it the right tab, read its report, and fix the parts it flags. Flags and file formats are in `README.md` ("Backing track", "Recordings that drift"); this skill is the judgement around them.

## Steps

1. **Inspect the tab.** `node src/cli.ts info <tab>`. Done when you know: is there a `[drums]` track (needed for `sync`), the tab's tempo, and whether `info` reports a lead-in (an empty first bar is the usual cause of a constant offset of about a bar).

2. **Pick the tab version** (only when there are several). Run `sync` on each with `-o <tmp>/<name>.sync.txt` so nothing next to the tabs is overwritten. Prefer, in order: covers the whole recording (no "The recording ends in bar N" well before the end, no 24-bar excerpt), most cymbals heard, lowest ms, fewest `listen` lines. A tab whose sections need a 50% or 200% tempo correction is in half or double time. Done when one version wins on these, and you can say why in one line per version.

3. **Run `sync`.** `node src/cli.ts sync <tab> --audio <recording>`. Without a drum track, skip to the fallback below.

4. **Work through every flag** in the report, in song order, since a fix early shifts everything after it:
   - *cymbal run not in the recording*: usually a break the band holds longer than written. Find where the music comes back in (see *landmarks*) and pin the bar after the run.
   - *also fits N s later/earlier*: the section may be a beat off. Check the first strong landmark in it and pin it if the fit is wrong.
   - *few of the tab's cymbals are heard*: the band plays it differently, or the crashes are buried. Only act if the sections either side disagree.
   
   Pin with `sync ... --sync "bar=m:ss, ..."` and rerun; pinned points are kept exactly and the rest are refitted. You can't hear the recording, so when a time can only be settled by ear, render that bar range (`render --bars a-b`) and ask the user for the time, naming the moment to listen for. Done when every flag is either fixed with a pin or explained (and the explanation told to the user).

5. **Render.** A plain `render <tab>` uses the saved `<tab>.sync.txt` with its recording. Done when the render's `Sync:` line names that file.

### Fallback: no drum track

`sync` can't run. Use `--audio-start` when the band holds the tab's tempo (the lead-in hint in `info` gives the value for a silent first bar), otherwise pin a few **landmarks** by hand with `--sync`, at least one near the start and one near the end, plus one at each tempo change or held break.

## Lessons

Each was learned by getting it wrong first on a real song.

- **Landmarks** are what alignment can trust: crash cymbals (sharp, ringing, above ~7 kHz), stops and breaks (a drop in full-band loudness, then the band coming back in), the first chord. Guitar and bass attacks are not: in dense music they come every 8th note, so matching them **aliases** and happily slips by one 8th while scoring well.
- Pitch (chroma) features are useless on songs that sit on one key, as most metal does: every shift looks equally similar.
- A steady-looking offset can hide **drift**. Measuring "the notes are 1.5 s late" at a few places and seeing the same number usually means the measurement slipped onto a neighbouring beat each time. Check the bar length directly (autocorrelation at 2- and 4-bar lags) before believing the tempo matches.
- Validate on **held-out** landmarks: fit on some, check on the others. A fit checked against the landmarks it was fitted to always looks good. `sync` does this for you; do the same for any analysis of your own.
- Tabs often differ from the recording in small ways: 8ths where the band plays 16ths, a roll the drummer skips, a break held a second longer. A disagreement in one section is more often the tab than the fit.
- The video reproduces the sync mapping exactly. To check alignment, check the mapping (the sync points against landmarks in the recording), not the rendered frames.
