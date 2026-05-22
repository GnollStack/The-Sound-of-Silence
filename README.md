<div align="center">

# The Sound of Silence

**Turn Foundry playlists into boss loops, smooth transitions, and living ambience.**

[![Latest Release](https://img.shields.io/github/v/release/GnollStack/The-Sound-of-Silence?label=Latest%20Release&style=flat-square)](https://github.com/GnollStack/The-Sound-of-Silence/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/GnollStack/The-Sound-of-Silence/total?style=flat-square&color=green)](https://github.com/GnollStack/The-Sound-of-Silence/releases)
[![Downloads@latest](https://img.shields.io/github/downloads/GnollStack/The-Sound-of-Silence/latest/total?style=flat-square)](https://github.com/GnollStack/The-Sound-of-Silence/releases/latest)
[![Foundry VTT](https://img.shields.io/badge/Foundry-v13%20%2F%20v14-orange?style=flat-square)](https://foundryvtt.com)
[![Ko-fi](https://img.shields.io/badge/Ko--fi-Buy%20a%20Steak-FF5E5B?style=flat-square&logo=ko-fi&logoColor=white)](https://ko-fi.com/gnollstack)

*For GMs who want music to help tell a story.*

[Features](#what-you-get) · [Quick Start](#quick-start) · [Preview](#preview) · [Installation](#installation) · [Use It For](#use-it-for) · [Compatibility](#compatibility) · [API](#developer-api) · [Community](#community) · [Contributing](#contributing) · [AI Use](#ai-use) · [Support](#support-development) · [License](#license-permissions)

</div>

---

## Feature Index

| Feature | Why it matters |
| --- | --- |
| **[Internal Loops](#internal-loop-sequencer)** | Keep the best part of a track running until the scene changes. |
| **[Crossfading](#auto-crossfade)** | Move from travel to combat without an ugly hard cut. |
| **[Silence Gaps](#silence-gaps)** | Let playlists breathe instead of firing every track back-to-back. |
| **[Soundscape](#soundscape-mode)** | Build ambience that keeps itself alive while you run the table. |

> *Foundry's default music player plays files. I wanted it to make the game feel alive: silence between tracks, crossfades, loops, dynamic ambience, and enough control to make boss fights fearsome and tavern nights cinematic.*

---

<a id="quick-start"></a>

## Quick Start

1. Install and enable **The Sound of Silence** in your world.
2. Open the **Playlists** sidebar and expand any playlist.
3. Use the playlist header toggles for silence gaps, auto-crossfade, playlist looping, or playback mode.
4. Right-click a playlist or sound and choose **Configure** for deeper setup, including internal loops and Soundscape defaults.

<img width="397" height="751" alt="Playlist configuration settings" src="https://github.com/user-attachments/assets/ec6abdae-3136-4bc3-98d8-13e86482760a" />

---

<a id="preview"></a>

## Preview

<img width="375" height="252" alt="Currently Playing transport controls" src="https://github.com/user-attachments/assets/3deaae6f-a8f7-4f9d-bb6f-5f863fbf33ab" />

---

<a id="what-you-get"></a>

## What You Get

### Internal Loop Sequencer
**Build intro → loop → outro structures inside a single track.**

Up to 16 segments per track with draggable handles, color-coded zones, crossfade preview, and live break controls in the transport. Treat one MP3 like a multi-part composition, no editing required.

<img width="444" height="564" alt="Internal loop editor" src="https://github.com/user-attachments/assets/bdf30e8b-93ad-409e-9078-1293fca74c9e" />

▶ **[Watch demo (2 min)](https://youtu.be/ykLuKt_UPlg)**

---

### Auto Crossfade
**Seamless equal-power blends between consecutive tracks.**

The same curve used in Logic Pro and Ableton, with constant perceived power across the blend, no harsh cuts, and no mid-fade dips. Inherit the playlist's fade-out time, or override per playlist.

▶ **[Watch demo (1 min)](https://youtu.be/7K72lde_jus)**

---

### Silence Gaps
**Natural pauses between tracks, static or randomized.**

Works in Sequential, Shuffle, and Simultaneous modes. Set a fixed gap, or a min/max range and let SoS pick. It gives a playlist room to breathe instead of slamming track-to-track.

▶ **[Watch demo (1 min)](https://youtu.be/qWQ8Ci46iiw)**

---

### Soundscape Mode
**Procedural ambience that runs itself.**

Bed tracks loop while procedural one-shots are GM-authored and synced to players by default. Configure cadence (Uniform / Fixed / Natural), polyphony caps, pan, and play-chance per sound; players can opt out to use local procedural timing when needed.

<img width="373" height="563" alt="Soundscape procedural roster and preview controls" src="https://github.com/user-attachments/assets/239080e1-500f-4753-963e-def61ae4ce47" />

<details>
<summary><strong>Internal loop sequencer — full detail</strong></summary>

- Multi-segment editor — up to 16 segments per track with start/end timestamps, crossfade duration, and loop count.
- Per-segment behavior — skip to next, play through, or fade out.
- Skip-intro jumps to the first loop point with a configurable fade-in.
- Visual timeline with draggable handles, color-coded segments, and crossfade-zone preview.
- Loop preview plays full loops or just the transition points; volume slider opens at the sound's configured volume.
- Live controls in the Currently Playing panel — break, skip prev/next segment, disable all loops.
- Between-segment skipping works from the current playback position, even after pressing Break.
- Finite loop retirement clears runtime state so API inspection does not report destroyed loopers as active.

</details>

<details>
<summary><strong>Automatic crossfading — full detail</strong></summary>

- Equal-power crossfades — the math used in Logic Pro and Ableton for constant perceived power across the blend.
- Configurable duration — inherit from the playlist's fade-out, or override.
- Exponential fade curves so volume changes sound linear to human hearing.
- Works with manual track skips, automatic progression, and across connected clients.

</details>

<details>
<summary><strong>Silence gaps — full detail</strong></summary>

- Static mode — fixed gap duration.
- Random mode — randomized within a configurable min/max range.
- Works in Sequential, Shuffle, and Simultaneous playback.

</details>

<details>
<summary><strong>Soundscape mode — full detail</strong></summary>

Soundscape is the 5th option in the playback-mode picker, alongside Soundboard / Sequential / Shuffle / Simultaneous. Inside it:

- **Bed layer** — repeating background tracks that start together with Play All, or one at a time.
- **Procedural cadence** — Uniform Random, Fixed Cadence, or Natural (center-weighted) timing per sound.
- **Startup mode** — Use Cadence, Stagger First Fire, or Immediate First Fire.
- **Polyphony cap** — limit overlapping one-shots, with Independent, Linear, or Soft chance-scaling.
- **Synced procedural fires** - the GM client chooses each live one-shot recipe and synced players play that same sound, sequence, pan, variance, fade-in, and scheduled start.
- **Client opt-out** - players can disable synced procedural events for local procedural RNG while beds and document playback state remain synced.
- **Audition** — test the full mix from the playlist's Preview control, or any procedural from its sound sheet. Both are local-only and neither affects live state.
- **Soundboard control** — play or stop any sound individually; auto-stops the playlist when the last sound ends.
- **Procedural Roster** — an at-a-glance table in playlist config showing cadence, first-fire, play-chance, and pan per sound.
- GMs see a Fire Now bolt button on each procedural; in a live soundscape it emits the same synced fire recipe, while preview and audition remain local-only.

</details>

<details>
<summary><strong>Currently Playing — redesign notes</strong></summary>

- Playlist-first layout — playlist name primary, track name secondary.
- Full transport row — repeat, silence, crossfade, internal loop, mode cycle, prev/next, pause/resume, stop.
- Dual Track Volume / Playlist Volume sliders side by side.
- Fade-aware progress bars — gray fade-in/fade-out zones over the amber progress.
- Loop control row stays visible across segment gaps and after Break.
- Soundscape group strips with caret, polyphony meter, group Stop button, and compact ~22px procedural rows.
- Height-clamped panel (`clamp(200px, 40vh, 480px)`) with a thin amber scrollbar, so the playlist directory stays reachable.
- Scroll-safe playback updates preserve directory scroll position during track advances.

</details>

<details>
<summary><strong>Advanced shuffle, fades, normalization</strong></summary>

**Shuffle:** Foundry Default, Exhaustive, Weighted Random, Round-Robin.
**Fade-in curves:** Logarithmic, Linear, S-Curve, Steep — per playlist.
**Fade-out:** exponential curves for perceptually linear volume reduction.
**Volume normalization:** per-playlist target with per-sound opt-out.
**Playlist looping:** integrates with silence gaps and crossfading.

</details>

<details>
<summary><strong>Diagnostics</strong></summary>

Enable **Trace Currently Playing Timers** in module settings for world-level timer logging across clients.

GMs can request a multi-client state snapshot:

```javascript
game.modules.get('the-sound-of-silence').api.requestClientDiagnostics()
```

After 3 seconds a dialog shows per-sound gain, fade status, AudioContext state, dedup sequence numbers, playback-clock drift, and core audio volume. Red highlights stuck gains and suspended contexts; amber highlights active fades.

For MCP-based diagnostics, enable both **Enable Debug Logging** and **Enable MCP Diagnostics**, then use the Foundry MCP Bridge generic action tool:

```javascript
call-module-debug-action({
  moduleId: "the-sound-of-silence",
  action: "getStatus",
  args: {}
})
```

These diagnostics intentionally ship with the module, but are disabled by default and require explicit GM-side settings before use. Available read-only actions are allowlisted under `game.modules.get("the-sound-of-silence").api.diagnostics.actions`: `getStatus`, `parseText`, `validateText`, `openWindow`, `collectClientDiagnostics`, and `runSmokeTests`. They are GM-only, JSON-safe, and never create world documents. `collectClientDiagnostics` can be filtered with `playlistIds` to keep remote payloads compact. `getStatus` includes an audio preflight snapshot; `audio.locked: true` or zero available audio contexts means live media tests such as crossfade cannot prove real playback until the GM client unlocks Foundry audio.

Dedicated test worlds can also enable **Enable MCP Playback Automation**. Mutating automation actions require that setting plus `confirmMutation: true` in the call args. The allowlisted mutating actions are `controlPlayback`, `runPlaybackAutomation`, `runClientSyncAutomation`, and `cleanupPlaybackFixtures`; fixture cleanup only touches SoS MCP fixture playlists with the expected marker flag and `SoS MCP Test -` name prefix. Automation fixtures prefer known playable world audio paths when available and fall back to generated WAV data URIs. `runPlaybackAutomation` includes shuffle-pattern checks for exhaustive, weighted-random, and round-robin ordering, custom fade checks for all configured curve types, loop retirement cleanup, and advanced soundscape checks for procedural one-shots, polyphony caps, default inheritance, panners, and bed cleanup. `runClientSyncAutomation` requires active non-GM clients by default and compares their remote snapshots against GM-driven playback actions, including crossfade, stop, loop break/disable/segment-skip replication, and soundscape start/stop, bed-only, procedural-fire, arm/disarm, opt-out, and cleanup scenarios. Live-media checks are reported as inconclusive, not failed, when a target client has locked audio, no running audio context, or no live media object.

> [!WARNING]
> If the GM owns the playlist, sets Foundry's Music Volume to exact `0`, and backgrounds the tab, the browser audio clock can stall. Use `0.01` or mute the tab/OS instead.

</details>

---

<a id="installation"></a>

## Installation

1. Foundry → **Add-on Modules** → **Install Module**.
2. Search "Sound of Silence", or paste this manifest URL:

```text
https://github.com/GnollStack/The-Sound-of-Silence/releases/latest/download/module.json
```

3. Enable the module in your world.

| Requirement | Version |
| --- | --- |
| Foundry VTT | v13+ (verified through v14.360) |
| [libWrapper](https://github.com/ruipin/fvtt-lib-wrapper) | Latest |

---

<a id="use-it-for"></a>

## Use It For

| Use case | What it looks like |
| --- | --- |
| **Boss battles** | Build multi-phase music in a single track. Break the loop to advance phases. |
| **Atmosphere** | Soundscape mode runs evolving ambience without manual cueing. |
| **Narrative beats** | Equal-power crossfades carry emotional turns without harsh cuts. |
| **Music curation** | Love part of a song, hate the rest? Loop only the parts you want. |

<details>
<summary><strong>Recipe — boss battle, multi-phase music</strong></summary>

```text
Segment 1  00:00–01:30   Intro      loop 1×, skip to next
Segment 2  01:30–03:00   Phase 1    loop ∞
Segment 3  03:00–04:45   Phase 2    loop ∞
Segment 4  04:45–06:00   Victory    loop 1×, play through
```

Intro plays once, jumps to Phase 1. Click *break* when the boss enters Phase 2. Break again on defeat, and victory plays once before the track ends.

</details>

<details>
<summary><strong>Recipe — rainy forest soundscape</strong></summary>

| Track | Role | Config |
| --- | --- | --- |
| Forest Bed | Bed | Repeat on |
| Wind Gust | Procedural | Uniform 10–25s, random pan |
| Bird Call | Procedural | Natural 6–18s, 70% chance |
| Branch Creak | Procedural | Fixed 30s, stagger first fire |

</details>

---

<a id="compatibility"></a>

## Compatibility

> [!TIP]
> Run SoS as your only playlist/audio module. It's a superset of Monks Sound Enhancements and Playlist Enchantment's audio features. Keep them only if you use their non-audio features (actor sounds, drag-drop upload, prehear preview).

<details>
<summary><strong>Monks Sound Enhancements</strong></summary>

**Module ID:** `monks-sound-enhancements` · Compatible with caveats.

**Overridden by SoS:** Currently Playing UI, playlist config sheet, sound-effect volume slider.

**Still works alongside:** actor/token sound effects, `@Sound[]` enrichers, combat-turn sounds, drag-and-drop between playlists, hotbar macros, playlist tooltips, name/playlist hiding.

</details>

<details>
<summary><strong>Playlist Enchantment</strong></summary>

**Module ID:** `playlistenchantment` · Compatible with caveats.

**Overridden by SoS:** Currently Playing UI, cross-playlist crossfade, volume normalization, fade-in/out, playlist loop toggle, global play/stop/skip-all.

**Still works alongside:** drag-drop audio upload, prehear preview, hotbar macros, hotbar hover popup.

> [!WARNING]
> Enchantment's `alwaysFade` setting forces fades on every playlist update and can interfere with SoS crossfades. SoS guards against it, but disable `alwaysFade` for cleanest behavior.

</details>

<details>
<summary><strong>UI-layer notes for other module authors</strong></summary>

SoS replaces `PARTS.playing` at the `ready` hook and renders sound rows through its own partials (`sos-sound-partial.hbs`, `sos-soundscape-group.hbs`). Foundry's core selectors (`.sound[data-sound-uuid]`, `.current`, `.duration`, `.pause`) are preserved via hidden compatibility targets. SoS uses the `--sos-*` CSS prefix; click targets are `data-sos-action` attributes. Wheel events on SoS volume controls bypass the panel scrollbar.

</details>

---

<a id="developer-api"></a>

## Developer API

Access:

```javascript
const api = game.modules.get("the-sound-of-silence").api;
```

<details>
<summary><strong>Playback control</strong></summary>

```javascript
api.crossfadeToNext(playlist, fromSound)
api.startLoop(sound) / stopLoop(sound, options) / breakLoop(sound)
api.playSoundWithFadeIn(sound, overrideFadeInMs)
api.stopSoundWithFadeOut(sound, overrideFadeOutMs)
api.fade(sound, targetVolume, durationMs)
api.crossfade(soundOut, soundIn, durationMs)
```

</details>

<details>
<summary><strong>Configuration &amp; state</strong></summary>

```javascript
api.getPlaylistConfig(playlist) / updatePlaylistConfig(playlist, updates)
api.getLoopConfig(sound)         / updateLoopConfig(sound, loopConfig)
api.getPlaybackMode(playlist)

api.isLooping(sound)
api.isCrossfadeScheduled(playlist)
api.isSilenceActive(playlist)
api.getCurrentLoopSegment(sound)
api.getAllLoopingSounds()
api.getActivePlaylists()

api.enableFeature(playlist, feature)  / disableFeature(playlist, feature)
```

</details>

<details>
<summary><strong>Diagnostics &amp; utilities</strong></summary>

```javascript
api.requestClientDiagnostics()   // GM-only multi-client snapshot
api.inspectPlaylist(playlist) / inspectAll()
api.getMetrics() / resetMetrics()

api.findSounds(name)
api.toSeconds("01:30") / formatTime(seconds, showMs)
api.cleanup(playlist, options)
```

</details>

<details>
<summary><strong>Hook events</strong></summary>

```javascript
the-sound-of-silence.crossfadeStart      / crossfadeComplete
the-sound-of-silence.loopStart           / loopIteration / loopEnd
the-sound-of-silence.silenceStart        / silenceEnd
```

</details>

### Example macros

**Crossfade the active playlist to its next track.**

```javascript
const api = game.modules.get("the-sound-of-silence").api;
const playlist = game.playlists.getName("Combat");
const current  = playlist?.sounds.find(s => s.playing);
if (!playlist || !current) return ui.notifications.warn("Nothing playing.");

await api.crossfadeToNext(playlist, current);
```

**Break the current loop on every looping sound.** Useful as a "phase change" hotbar macro during boss fights.

```javascript
const api = game.modules.get("the-sound-of-silence").api;
const looping = api.getAllLoopingSounds();
if (!looping.length) return ui.notifications.info("No active loops.");

for (const sound of looping) api.breakLoop(sound);
ui.notifications.info(`Broke ${looping.length} loop(s).`);
```

**Capture a multi-client diagnostic snapshot.** GM-only; opens a side-by-side comparison dialog after ~3 seconds.

```javascript
game.modules.get("the-sound-of-silence").api.requestClientDiagnostics();
```

**Toggle the soundscape on a playlist by name.**

```javascript
const api = game.modules.get("the-sound-of-silence").api;
const playlist = game.playlists.getName("Rainy Forest");
if (!playlist) return ui.notifications.warn("Playlist not found.");

const mode = api.getPlaybackMode(playlist);
mode.soundscape
  ? await api.disableFeature(playlist, "soundscape")
  : await api.enableFeature(playlist, "soundscape");
```

---

<a id="roadmap"></a>

## Roadmap

| Item | What it unlocks |
| --- | --- |
| **Cross-playlist crossfading** | Fade from Exploration → Combat without manually stopping the first playlist. |
| **Intro-to-playlist linking** | Play a one-shot intro track, then auto-switch into a looping playlist. |
| **Preset system** | Save, load, and share loop configurations between worlds and GMs. |
| **Automation triggers** | Fire on combat start, scene change, or arbitrary hook conditions. |
| **Non-sequential segments** | Jump between loop segments in any order, not just forward. |

---

<a id="community"></a>

## Community

- **Report bugs** — [open an issue](https://github.com/GnollStack/The-Sound-of-Silence/issues) with your Foundry version, module version, steps to reproduce, console logs, and screenshots or short clips when useful.
- **Request features** — tell me what happened at your table and what you wish the module could do.
- **Star the repo** — if the module is useful at your table, a star helps other GMs find it.
- **Watch releases** — follow the repo for updates, compatibility notes, and new feature releases.

---

<a id="contributing"></a>

## Contributing

Bug reports, feature ideas, reproduction notes, documentation fixes, and localization ideas are welcome.

I am not generally accepting unsolicited code PRs for features, refactors, architecture, or behavior changes. This is still my module and my codebase; I will decide how features are designed and implemented unless I explicitly say otherwise.

- **Bug reports** — include Foundry version, module version, a console log, and the steps to reproduce. Screenshots or short clips help a lot.
- **Feature requests** — tell me what happened at your table and what you wish the module could do.
- **Pull requests** — please do not open code PRs unless I ask for one. Open an issue with the idea instead.
- **Code ownership** — core implementation, architecture, and release decisions remain with GnollStack unless stated otherwise.
- **Translations and docs** — typo fixes, wording suggestions, and localization ideas are welcome by issue first. I do not have a public translation setup yet, so I will fold useful wording in myself.

Submitted ideas may be adapted, declined, or implemented by GnollStack. Any accepted contribution or submitted project material may be released under the same EULA as the rest of the module.

---

<a id="ai-use"></a>

## AI-Assisted Development

This module is developed and maintained with the help of AI-assisted tools for coding, debugging, documentation, and testing.

I care about the quality, behavior, performance, security, and long-term maintainability of this module, and I take full responsibility for what ships. AI assistance does not replace review, testing, debugging, or security and design judgment.

AI is used here as a tool under my direction to make Foundry better and allow for long term mod support while still having a life outside of building and maintaining my free and premium modules.

If you are uncomfortable using software developed with AI-assisted tooling, this module is not for you.

---

<a id="support-development"></a>

## 🥩 Support Development

This module represents **many hours** of development.

**If this module enhanced your immersion, consider treating me to a steak, much better than coffee!**

<a href='https://ko-fi.com/gnollstack' target='_blank'>
<img height='36' style='border:0px;height:36px;' src='https://storage.ko-fi.com/cdn/kofi3.png?v=3' border='0' alt='Buy Me a Steak at ko-fi.com' />
</a>

> *"Thanks for the support! It helps me maintain support for the module and puts a nice steak on the table."*

---

<a id="license-permissions"></a>

## ⚖️ License & Permissions

### Proprietary EULA
This module is licensed under the **GnollStack Proprietary EULA**.
It is **Free for Personal Use**, meaning you can use it in your home games, stream it, or modify it for your own table without restriction.

However, **Commercial Redistribution is Strictly Prohibited.**
You may **NOT** sell this module, bundle it within paid content (such as Patreon maps or adventures), or host it as a commercial service without prior written consent.

### Commercial Licensing
I am open to partnerships! If you are a map maker, adventure writer, or developer who wishes to use this module commercially, please contact me. I offer commercial licenses for:
* Bundling this module with paid VTT content.
* Official integration into commercial systems.
* Custom feature development for your specific product.

### Contact
For licensing inquiries or permission slips:
* **Discord:** `GnollStack` (Preferred)
* **Email:** `Somedudeed@gmail.com`
* *Please do not open GitHub Issues for commercial licensing discussions. But feel free to contact me via Discord or Email*

---

<div align="center">

**Author:** [GnollStack](https://github.com/GnollStack) · **Compatibility:** Foundry VTT v13+ (verified v14.360)

[⬆ Back to Top](#the-sound-of-silence)

</div>
