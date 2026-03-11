<div align="center">

# The Sound of Silence
**Transform Foundry VTT's playlists into a professional sound design studio**

[![Release](https://img.shields.io/github/v/release/GnollStack/The-Sound-of-Silence)](https://github.com/GnollStack/The-Sound-of-Silence/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/GnollStack/The-Sound-of-Silence/total)](https://github.com/GnollStack/The-Sound-of-Silence/releases)
![Downloads@latest](https://img.shields.io/github/downloads/GnollStack/The-Sound-of-Silence/latest/total)
[![Foundry VTT](https://img.shields.io/badge/Foundry-v13-informational)](https://foundryvtt.com)

> Professional audio engineering for your tabletop RPG. Create complex musical compositions with seamless loops, cinematic crossfades, and dynamic silence — without touching a single audio file.

</div>

---

## Quick Start

1. **Install** from Foundry's Add-on Modules browser (search "Sound of Silence")
2. **Open any playlist** — click the toggle buttons in the header to enable silence gaps, crossfading, or playlist looping
3. **Configure** individual sounds with the loop icon, or open playlist settings for global controls

---

## Demo Videos

| Feature | Video | Description |
|---------|-------|-------------|
| **Silence Gaps** | [Watch (1 min)](https://youtu.be/qWQ8Ci46iiw) | Add natural pauses between tracks, static or random |
| **Crossfading** | [Watch (1 min)](https://youtu.be/7K72lde_jus) | Seamless transitions without harsh cuts |
| **Internal Loops** | [Watch (2 min)](https://youtu.be/ykLuKt_UPlg) | Create intro, loop, outro structures with true crossfade |

---

<details>
<summary> <strong>UI Screenshots</strong></summary>

### Playlist Header Controls
<img width="271" alt="Toggle buttons for silence, crossfade, and loop" src="https://github.com/user-attachments/assets/f8f895d2-091a-4128-9531-539f7a7becdc" />

### Playlist Configuration
<img width="281" alt="Extended playlist settings" src="https://github.com/user-attachments/assets/005a5e91-faa2-470c-a287-a1ed4a362fb5" />

### Sound Configuration
<img width="281" alt="Internal loop settings with multi-segment editor" src="https://github.com/user-attachments/assets/e4a19528-e0fe-4cda-be3e-9164515ae9f4" />

</details>

---

## Features

### Internal Loop Sequencer

Create professional game audio structures within a single track:

- **Multi-segment editor** — Define up to 16 loop segments per track, each with start/end timestamps, crossfade duration, and loop count
- **Segment behaviors** — Skip to next segment after loops complete, play through naturally, or let the track gracefully fade out
- **Skip intro** — Jump directly to your first loop point for instant atmosphere, with a configurable fade-in at the loop point
- **Visual timeline** — Interactive preview with draggable handles, color-coded segments, and crossfade zone visualization
- **Loop preview** — Play full segment loops or just the transition points to fine-tune your crossfade timing
- **Live controls** — Break the current loop, skip to next/previous segments, or disable all loops from the currently-playing section
- **Equal-power crossfades** between loop iterations for seamless transitions

### Automatic Crossfading

Seamlessly blend between consecutive tracks:

- **Equal-power crossfades** — the same technique used in professional DAWs like Logic Pro and Ableton
- **Configurable duration** — inherit from the playlist's fade-out setting or set a custom crossfade duration
- **Exponential fade curves** — perceptually linear fading that sounds natural to human hearing
- Works with manual track skips and automatic progression
- Synchronized across all connected clients

### Silence Gaps

Insert pauses between tracks to simulate natural music flow:

- **Static mode** — fixed gap duration
- **Random mode** — randomized within a configurable min/max range
- Works in Sequential, Shuffle, and Simultaneous modes

### Playlist Looping

Loop an entire playlist from the beginning when it reaches the end. Works in Sequential, Shuffle, and Simultaneous modes, and integrates with silence gaps and crossfading.

### Fade-In / Fade-Out

- **Configurable fade-in** per playlist with four curve types: Logarithmic, Linear, S-Curve, and Steep
- **Fade-out** uses exponential curves for perceptually linear volume reduction

### Volume Normalization

Set a target volume for all tracks in a playlist. Individual sounds can opt out with a per-sound override flag.

### Advanced Shuffle

Four shuffle algorithms (configured in module settings):

- **Foundry Default** — built-in random (can repeat)
- **Exhaustive** — all tracks play once before reshuffling
- **Weighted Random** — favors less-recently-played tracks
- **Round-Robin** — strict even distribution over time

### Diagnostics

Built-in diagnostics panel (stethoscope icon in the playlist directory header) for inspecting module state and performance metrics.

---

## Perfect For

**Combat** — Design dynamic battle music: tension intro, combat loop, victory fanfare, all in one track.

**Music Curation** — Found a song you love but with sections you don't? Use segment loops to play only the parts you want.

**Atmosphere** — Create evolving soundscapes that never feel repetitive with randomized silence and multi-segment loops.

**Boss Battles** — Build multi-phase soundscapes: Phase 1 theme, enraged Phase 2, then defeat/victory. Break loops manually to advance phases.

**Narrative Moments** — Fade between emotional beats with professional crossfades.

---

## Installation

### From Foundry VTT (Recommended)
1. Go to **Add-on Modules** > **Install Module**
2. Search for **"The Sound of Silence"**
3. Click **Install**

### Manual Installation
1. Copy this manifest URL:
   ```
   https://github.com/GnollStack/The-Sound-of-Silence/releases/latest/download/module.json
   ```
2. Go to **Add-on Modules** > **Install Module**
3. Paste in the **Manifest URL** field
4. Click **Install**

### Requirements
- **Foundry VTT v13+**
- **[libWrapper](https://github.com/ruipin/fvtt-lib-wrapper)**

---

## Usage Guide

### Basic Setup

1. **Configure playlist settings** — Right-click a playlist > **Configure** to set fade-in duration, silence mode/duration, crossfade options, volume normalization, and playlist looping.

2. **Toggle features from the sidebar** — Click the toggle buttons in any playlist header:
   - Hourglass = Silence Gaps
   - Arrows = Auto-Crossfade
   - Loop indicator = Loop Playlist

3. **Set up internal loops** (optional) — Right-click any sound > **Configure**, enable Internal Looping, then add segments with start/end times, crossfade duration, and loop counts.

### Multi-Segment Loop Example

**Boss Battle Music:**
```
Segment 1: 00:00 - 01:30 (Intro, loop 1x, skip to next)
Segment 2: 01:30 - 03:00 (Phase 1, loop infinitely)
Segment 3: 03:00 - 04:45 (Phase 2, loop infinitely)
Segment 4: 04:45 - 06:00 (Victory, loop 1x, play through)
```

How it works:
1. Track plays the intro once
2. Automatically jumps to Phase 1 loop
3. Click the break-loop button in the UI when the boss enters Phase 2
4. Track jumps to Phase 2 loop
5. Break the loop again when defeated — victory music plays once and the track ends

---

## Important Notes

### Feature Interactions
- **Crossfade and silence are mutually exclusive** — enabling crossfade automatically disables silence (by design, for clean transitions)
- **Pause is disabled during crossfades** — prevents audio glitches during internal loop transitions

### Performance
- **Dual-buffer architecture** — only 2 sound instances loaded at a time, regardless of segment count
- **Audio-thread scheduling** — all fades run on Foundry's dedicated audio context with zero main-thread impact
- **Automatic memory management** — WeakMap-based state storage is garbage collected, preventing leaks during long sessions
- **Long audio files (15+ min)** may have a 1-2 second delay during initial loop setup due to audio decoding; subsequent loops are instant. Consider shorter files or Opus/OGG format for faster decoding.

---

## For Developers

### Architecture
- Web Audio API for sample-accurate timing
- Dual-buffer crossfading system (soundA/soundB architecture)
- AudioTimeout (Foundry v13) for browser-throttle-resistant scheduling
- Equal-power crossfades (sin²θ + cos²θ = 1 for constant perceived power)
- Exponential curves for perceptually-linear volume changes

### Public API

```javascript
const api = game.modules.get("the-sound-of-silence").api;
```

**Configuration:**
- `getPlaylistConfig(playlist)` / `updatePlaylistConfig(playlist, updates)`
- `getLoopConfig(sound)` / `updateLoopConfig(sound, loopConfig)`
- `getPlaybackMode(playlist)` — returns active feature states

**Playback Control:**
- `crossfadeToNext(playlist, fromSound)` — trigger manual crossfade
- `startLoop(sound)` / `stopLoop(sound, options)` / `breakLoop(sound)`
- `playSoundWithFadeIn(sound, overrideFadeInMs)` / `stopSoundWithFadeOut(sound, overrideFadeOutMs)`
- `fade(sound, targetVolume, durationMs)` — exponential fade
- `crossfade(soundOut, soundIn, durationMs)` — equal-power crossfade

**State Queries:**
- `isLooping(sound)` / `isCrossfadeScheduled(playlist)` / `isSilenceActive(playlist)`
- `getCurrentLoopSegment(sound)` — active segment info
- `getAllLoopingSounds()` — all currently looping sounds across playlists
- `getActivePlaylists()` — all playlists with active features
- `inspectPlaylist(playlist)` / `inspectAll()` — detailed state snapshots
- `getMetrics()` / `resetMetrics()` — performance data

**Feature Management:**
- `enableFeature(playlist, feature)` / `disableFeature(playlist, feature)`

**Utilities:**
- `findSounds(name)` — search by partial name
- `toSeconds(timeString)` / `formatTime(seconds, showMs)` — time conversion
- `cleanup(playlist, options)` — cleanup all state

### Hook Events

- `the-sound-of-silence.crossfadeStart` / `crossfadeComplete`
- `the-sound-of-silence.loopStart` / `loopIteration` / `loopEnd`
- `the-sound-of-silence.silenceStart` / `silenceEnd`

---

## Compatibility

### Tested & Compatible
- Monk's Enhanced Audio
- Playlist Enhancements
- All game systems
- Foundry VTT v13+

### Known Conflicts
None reported. If you find a compatibility issue, please [open an issue](https://github.com/GnollStack/The-Sound-of-Silence/issues).

---

## Roadmap

- [ ] Cross-playlist crossfading (fade from Exploration to Combat playlists)
- [ ] Intro-to-playlist linking (play intro track, then auto-switch to looping playlist)
- [ ] Preset system (save/load/share loop configurations)
- [ ] Playlist automation triggers (on combat start, on scene change)
- [ ] API expansion for macro/module integration
- [ ] Expanded diagnostics dashboard
- [ ] Non-sequential segment playback (jump between segments in any order)

---

## Community

- [Report Bugs](https://github.com/GnollStack/The-Sound-of-Silence/issues) — help improve the module with detailed reproduction steps
- [Request Features](https://github.com/GnollStack/The-Sound-of-Silence/issues) — if it's within scope and feasible, there's a good chance it'll get built
- Star this repo if you find it useful

---

## License & Permissions

### Proprietary EULA
This module is licensed under the **GnollStack Proprietary EULA**.
It is **free for personal use** — you can use it in your home games, stream it, or modify it for your own table without restriction.

**Commercial redistribution is strictly prohibited.**
You may not sell this module, bundle it within paid content (such as Patreon maps or adventures), or host it as a commercial service without prior written consent.

### Commercial Licensing
I am open to partnerships. If you are a map maker, adventure writer, or developer who wishes to use this module commercially, please get in touch. Commercial licenses are available for:
* Bundling with paid VTT content
* Official integration into commercial systems
* Custom feature development

### Contact
For licensing inquiries:
* **Discord:** `GnollStack` (preferred)
* **Email:** `Somedudeed@gmail.com`

Please do not open GitHub issues for commercial licensing discussions.

---

**Author:** [GnollStack](https://github.com/GnollStack)
**Compatibility:** Foundry VTT v13+

---

<div align="center">

[Back to Top](#the-sound-of-silence)

</div>
