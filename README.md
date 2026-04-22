<div align="center">

# The Sound of Silence
**Transform Foundry VTT's playlists into a professional sound design studio**

[![Release](https://img.shields.io/github/v/release/GnollStack/The-Sound-of-Silence)](https://github.com/GnollStack/The-Sound-of-Silence/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/GnollStack/The-Sound-of-Silence/total)](https://github.com/GnollStack/The-Sound-of-Silence/releases)
![Downloads@latest](https://img.shields.io/github/downloads/GnollStack/The-Sound-of-Silence/latest/total)
[![Foundry VTT](https://img.shields.io/badge/Foundry-v13%2Fv14-informational)](https://foundryvtt.com)
[![Ko-fi](https://img.shields.io/badge/Ko--fi-Buy%20a%20Steak-FF5E5B?logo=ko-fi&logoColor=white)](https://ko-fi.com/gnollstack)

> Professional audio engineering for your tabletop RPG. Create complex musical compositions with seamless loops, cinematic crossfades, and dynamic silence — without touching a single audio file.

</div>

---

## Quick Start

**Get started in 30 seconds:**

1. **Install** from Foundry's Add-on Modules browser (search "Sound of Silence")
2. **Open any playlist** → Click the toggle buttons in the header ( 🔀 🔁)
3. **Configure** individual sounds with the orange loop icon or playlist settings

## Why The Sound of Silence?

| Feature | Demo Video | What You'll See |
|---------|------------|-----------------|
| **Silence Gaps** | [▶️ 1 min](https://youtu.be/qWQ8Ci46iiw) | Add natural pauses between tracks, static or random |
| **Crossfading** | [▶️ 1 min](https://youtu.be/7K72lde_jus) | Seamless transitions without harsh cuts |
| **Internal Loops** | [▶️ 2 min](https://youtu.be/ykLuKt_UPlg) | Create intro → loop → outro structures, True Crossfade! |

---

<details>
<summary> <strong>UI Screenshots</strong></summary>

### Currently Playing
<!-- Replace the src below with an uploaded GitHub asset URL after taking a screenshot -->
<img width="367" height="245" alt="image" src="https://github.com/user-attachments/assets/7c833a43-041b-469d-884d-002ad427c3c9" />

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
- **Live controls** — Break the current loop, skip to next/previous segments, or disable all loops directly from the redesigned Currently Playing panel
- **Equal-power crossfades** between loop iterations for seamless transitions
- **Preview volume** - The loop preview controls include a volume slider that opens at the sound's configured volume and drives both full-loop and loop-point previews
- **Between-segment skipping** - Previous/next segment controls can jump based on the current playback position even after breaking out of an active loop

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

### Soundscape Mode

Turn a playlist into a procedural ambience engine without giving up manual control:

- **One-click activation** - "Soundscape" is the 5th option in the Playback Mode picker, right alongside Soundboard / Sequential / Shuffle / Simultaneous. The native sidebar mode-cycle icon and Currently Playing cycle button both cycle through all five modes so the sidebar and transport UI stay in sync.
- **True soundboard control** - play and stop each sound independently. Click play on one bed and only that bed plays. Click play on one procedural and only that procedural arms its timer. Click stop on any single sound and only that sound stops - other sounds keep going.
- **Play All / Stop All still work** - the playlist header Play button starts every non-gap track and arms every procedural; Stop All halts everything.
- **Auto-stop on last sound** - when the last playing sound is stopped individually, the playlist itself stops and the engine tears down. No need to press Stop All separately.
- **Bed layer** - repeating background tracks can be started together with Play All or manually one at a time.
- **Procedural cadence** - each procedural one-shot can use Uniform Random, Fixed Cadence, or Natural (Center-Weighted) timing, plus Use Cadence, Stagger First Fire, or Immediate First Fire startup behavior.
- **Post-playback gaps** - Min Gap / Max Gap are measured after each fire ends, not start-to-start, which keeps long clips and 0 / 0 setups safe.
- **Proper fades** - procedural fires fade in from silence using the module's configured fade curve (logarithmic / linear / s-curve / steep), honor the per-playlist `fadeIn` flag, and fade out smoothly when stopped.
- **Client-local variation** - each connected client runs its own procedural timing, so the ambience stays organic instead of perfectly synchronized.
- **Polyphony limits** - cap how many one-shots can overlap at once, with Independent, Linear by Polyphony, and Soft by Polyphony chance-scaling modes.
- **Playlist-level defaults** - the Soundscape panel sets fallback gap, cadence, first-fire, variance, play-chance, and pan values so new procedural sounds inherit playlist-wide preferences.
- **Effective per-sound editing** - the sound config sheet shows the resolved procedural values from playlist defaults and includes live cadence, startup, and approximate plays-per-minute previews.
- **Procedural Roster** - the playlist config sheet shows an at-a-glance table of every procedural sound with its cadence, first-fire mode, play chance, and pan setting.
- **GM Fire Now testing** - GMs see a bolt button on each armed procedural card to fire it immediately (client-local), making it easy to audition the sound mix without waiting for the timer.
- **Per-card play-chance badge + polyphony meter** - the Currently Playing panel shows each procedural sound's effective play chance (when below 100%) and a shared `active/max` polyphony meter on the playlist header row.

### Advanced Shuffle

Four shuffle algorithms (configured in module settings):

- **Foundry Default** — built-in random (can repeat)
- **Exhaustive** — all tracks play once before reshuffling
- **Weighted Random** — favors less-recently-played tracks
- **Round-Robin** — strict even distribution over time

### Redesigned Currently Playing Section

The "Currently Playing" panel in the sidebar has been completely overhauled with a proper transport control layout:

- **Playlist-first layout** - each track card shows the playlist name as the primary header, with the track name secondary below it.
- **Grouped by playlist** - soundscape rows share one playlist header and playlist-volume row, so large ambience playlists stay compact.
- **Full transport row** - repeat, silence toggle, crossfade toggle, internal loop toggle, playlist mode cycle, previous track, next track, pause/resume, stop.
- **Inline playlist controls** - toggle silence gaps, auto-crossfade, and cycle playback mode (disabled/sequential/shuffle/simultaneous/soundscape) directly from the Currently Playing panel, even when the playlist is hidden in a folder.
- **Bidirectional sync** - all toggles stay in sync with the sidebar playlist header buttons.
- **Pause/Resume toggle** - when a track is paused, the button switches to a play icon so you can resume without stopping.
- **Dual volume sliders** - separate Track Volume and Playlist Volume sliders, aligned for easy comparison.
- **Loop controls row** - appears whenever a track has live loop segments and stays visible across the gap between segments (and after pressing Break) so you can react to whatever loops next. Prev/next segment buttons grey out automatically at the first/last segment, plus break loop and disable loops.
- **Live state** - crossfade status and loop segment changes update the panel automatically.
- **Loop button state** - Break greys out by itself when no loop is currently active, while previous/next remain available whenever there is a segment to jump to in that direction.
- **Compact procedural rows** - soundscape one-shots render as a single ~22px row with the dice icon, track name, optional play-chance badge, and `Playing` / `Armed` / `Next in ~Ns` ETA. Fire Now and Stop buttons stay hidden at rest and slide in on hover, so dense ambience playlists (9+ one-shots) no longer flood the panel.
- **Soundscape Stop All** - each active soundscape playlist gets a small stop button next to its polyphony meter so the GM can halt every bed and procedural in one click without scrolling for the sidebar Stop All.
- **Capped height with scroll** - the panel is height-clamped (`200px` / `40vh` / `480px` floor / preferred / ceiling) and the inner sound list gets a thin amber custom scrollbar. With many tracks playing the playlists directory below stays reachable instead of being pushed off-screen.

### Diagnostics

Debug logging is the primary troubleshooting path. Developer inspection remains available through `game.modules.get('the-sound-of-silence').api.inspectAll()`.

#### Remote Client Diagnostics

When debugging multi-client issues (GM hears audio but players don't, sounds breaking mid-playback), the GM can request a state snapshot from every connected client:

```javascript
game.modules.get('the-sound-of-silence').api.requestClientDiagnostics()
```

After 3 seconds, a dialog appears showing each client's audio state side-by-side:
- **Per-sound gain values** — immediately reveals if a sound is stuck at gain 0
- **Fade status** — shows which sounds have active `setValueCurveAtTime` curves
- **AudioContext state** — detects suspended contexts from background tabs
- **Sequence numbers** — compares GM and player dedup counters to diagnose replication failures

Visual indicators highlight problems automatically: red for stuck gains or suspended contexts, amber for active fades.

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
- **Foundry VTT v13+** verified through v14.360
- **[libWrapper](https://github.com/ruipin/fvtt-lib-wrapper)**

---

## Usage Guide

### Basic Setup

1. **Configure playlist settings** - Right-click a playlist > **Configure** to set fade-in duration, silence mode/duration, crossfade options, volume normalization, playlist looping, and soundscape defaults.

2. **Toggle features from the sidebar** - Click the toggle buttons in any playlist header for Silence Gaps, Auto-Crossfade, or Loop Playlist.

3. **Set up internal loops** (optional) - Right-click any sound > **Configure**, enable Internal Looping, then add segments with start/end times, crossfade duration, and loop counts.

4. **Set up soundscape ambience** (optional) - Set the playlist's Playback Mode to **Soundscape** (the 5th option, with the dice icon), then mark individual tracks as procedural one-shots or leave them as normal/manual tracks.

### Procedural Ambience Example

**Rainy Forest Playlist:**
- `Forest Bed` - repeat on, procedural off
- `Wind Gust` - procedural on, Uniform Random gap 10-25s, random pan on
- `Bird Call` - procedural on, Natural gap 6-18s, 70% play chance
- `Branch Creak` - procedural on, Fixed cadence 30s, Stagger First Fire, volume variance 0.15

**How it works:**
1. Set the playlist's Playback Mode to **Soundscape** (the dice-d20 option in the mode picker).
2. Optionally set Soundscape defaults in the playlist config so new procedural sounds inherit your preferred gap, cadence, and startup behavior.
3. Use **Play All** to start the full ambience session, or trigger individual sounds manually from the playlist when needed.
4. Let the bed track run continuously while one-shots fire on independent local timers using their own cadence rules.
5. Watch the Currently Playing panel show each procedural sound as a grouped ambient card with `Playing`, `Armed`, or `Next in ~Ns` status plus chance/polyphony indicators.

### Multi-Segment Loop Example

**Boss Battle Music:**
```
Segment 1: 00:00 - 01:30 (Intro, loop 1x, skip to next)
Segment 2: 01:30 - 03:00 (Phase 1, loop infinitely)
Segment 3: 03:00 - 04:45 (Phase 2, loop infinitely)
Segment 4: 04:45 - 06:00 (Victory, loop 1x, play through)
```

**How it works:**
1. Track plays the intro once
2. Automatically jumps to Phase 1 loop
3. Click the break-loop button in the UI when the boss enters Phase 2
4. Track jumps to Phase 2 loop
5. Break the loop again when defeated — victory music plays once and the track ends

---

## Important Notes

### Feature Interactions
- **Crossfade and silence are mutually exclusive** - enabling crossfade automatically disables silence (by design, for clean transitions).
- **Pause is disabled during crossfades** - prevents audio glitches during internal loop transitions.
- **Soundscape is its own playback mode** - pick it from the Playback Mode dropdown (or cycle the sidebar mode icon to the dice-d20 state). Individual tracks can be triggered manually from the playlist like a soundboard - clicking play on one sound starts only that sound; clicking stop on one sound only stops that sound.
- **Last-sound-stopped auto-stops the playlist** - stopping sounds one-by-one tears down the engine automatically once nothing is left playing.
- **Play All / Stop All still work** - pressing the playlist header Play button starts every non-gap track and arms every procedural; Stop All halts everything.
- **Soundscape disables silence and crossfade** - procedural ambience owns the playlist flow, so those toggles are locked while it is active.
- **Cadence and startup are separate controls** - cadence determines every recurring gap, while First Fire only affects the initial fire after activation.
- **Procedural defaults flow into sound sheets** - when a per-sound procedural value is unset, the sound config displays the resolved playlist default so the live behavior is visible before you save an override.
- **Polyphony scaling offers three behaviors** - Independent never adjusts chance, Linear by Polyphony attenuates evenly as the cap fills, and Soft by Polyphony tapers more gently.
- **Procedural fires honor fade curves** - the module's configured fade-in/out curves, the per-playlist `fadeIn` flag, and the playlist's native `fade` ms are all respected; short stingers have their fade-in capped at half the clip length so they still reach full volume.
- **Procedural gaps start after playback ends** - the next countdown begins when the current one-shot finishes, preventing duplicate fires on long clips and avoiding zero-delay lockups.

### Performance
- **Dual-buffer architecture** — only 2 sound instances loaded at a time, regardless of segment count
- **Audio-thread scheduling** — all fades run on Foundry's dedicated audio context with zero main-thread impact
- **Automatic memory management** — WeakMap-based state storage is garbage collected, preventing leaks during long sessions
- **Long audio files (15+ min)** may have a 1-2 second delay during initial loop setup due to audio decoding; subsequent loops are instant. Consider shorter files or Opus/OGG format for faster decoding.

---

## For Developers

### Architecture
- **Web Audio API** for sample-accurate timing
- **Dual-buffer crossfading** system (soundA/soundB architecture)
- **WeakMap-based state management** for automatic garbage collection
- **Audio-thread scheduling** via AudioContext.currentTime
- **Exponential curves** for perceptually-linear volume changes
- **Equal-power crossfades** (sin²θ + cos²θ = 1 for constant perceived power)

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

**Feature Management:**
- `enableFeature(playlist, feature)` / `disableFeature(playlist, feature)`

**Diagnostics:**
- `requestClientDiagnostics()` — (GM-only) query all connected clients' audio state, display side-by-side comparison dialog
- `inspectPlaylist(playlist)` / `inspectAll()` — detailed state snapshots
- `getMetrics()` / `resetMetrics()` — performance data

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

### Foundry VTT
- **v13+** required, verified through v14.360
- Compatible with all game systems

### Third-Party Playlist Modules

> **Recommended: Use The Sound of Silence as your only playlist/audio module.** SoS is a superset of both Monks Sound Enhancements and Playlist Enchantment's audio features — it provides crossfading, volume normalization, fade-in/out, enhanced shuffle, and playlist looping. Running additional audio modules forces SoS to activate defensive guards (sync interception, fade blocking, scheduled fade-out cancellation) to protect its audio pipeline from interference. These guards work, but they add complexity and fragility — if the other modules update and change how they interact with Foundry's audio graph, the guards may miss new code paths. **If you only use SoS, none of this is needed and the audio pipeline runs cleanly.**
>
> The only reasons to keep the modules below are their **non-audio features** — Monks' actor/token sound effects and `@Sound[]` journal links, or Enchantment's drag-drop file upload and prehear preview. If you don't use those features, disable them.

SoS includes a built-in integration layer that automatically detects and cooperates with these modules. SoS always owns the audio pipeline and the Currently Playing UI — crossfades, silence gaps, internal loops, and fade curves are never shared with or delegated to other modules.

#### Monks Sound Enhancements

| | |
|-|-|
| **Status** | Compatible with caveats |
| **Module ID** | `monks-sound-enhancements` |

**Overridden by SoS** (SoS provides its own version — these Monks features will not function):
- Currently Playing UI and playlist directory templates
- Playlist configuration sheet
- Sound effect volume slider in the controls panel

**Still works alongside SoS:**
- Actor/Token sound effects (speaker icon in Token HUD, actor/item sheet buttons)
- `@Sound[]` text enricher links in journal entries
- Combat turn sound effects (`playsound-combat` setting)
- Drag-and-drop sounds between playlists (Shift+drag to move)
- Hotbar macro creation for sounds
- Playlist description tooltips
- Sound name hiding and playlist hiding flags

#### Playlist Enchantment

| | |
|-|-|
| **Status** | Compatible with caveats |
| **Module ID** | `playlistenchantment` |

**Overridden by SoS** (SoS provides its own version — these Enchantment features will not function):
- Currently Playing UI and playlist directory templates
- Crossfade between playlists (use SoS crossfading instead)
- Volume normalization sliders (use SoS normalization instead)
- Fade-in/fade-out controls (use SoS fade settings instead)
- Playlist loop toggle (use SoS playlist looping instead)
- Global play/stop/skip-all controls

**Still works alongside SoS:**
- Drag-and-drop audio file upload to playlists
- Prehear (sound preview) context menu option
- Hotbar macro creation for playlists/sounds/folders
- Hotbar hover popup with sound controls

> **Warning:** Playlist Enchantment's `alwaysFade` setting forces Foundry to apply fade transitions on every playlist update, which can interfere with SoS crossfades. SoS guards against this, but for best results consider disabling the `alwaysFade` option in Enchantment's settings if you experience audio glitches during crossfade transitions.

### UI-Layer Conflicts

SoS owns the Currently Playing panel DOM. Any other module that tries to restyle or rewrite the same sidebar elements will either lose (if it goes through Foundry's PARTS template system) or visually fight with SoS (if it injects DOM after render). Specifically, SoS:

- **Replaces the `PARTS.playing` template** on the actual running `CONFIG.ui.playlists` class via `Integrations.patchPlayingParts()`. Any other module that also overrides `PARTS.playing` will be overridden by whichever loads last — SoS patches at the `ready` hook, which is late, so SoS normally wins.
- **Replaces each sound row** with its own `sos-sound-partial.hbs` partial. Modules that rely on Foundry's native `sound-partial.hbs` DOM (`.sound-controls.flexrow`, the native volume slider markup, etc.) will not see their expected selectors on rows rendered by SoS. The critical selectors Foundry itself reads (`.sound[data-sound-uuid]`, `.current`, `.duration`, `.pause`) are preserved.
- **Caps the panel height and styles the scrollbar** on `.currently-playing.global-control.location-top/bottom` and `.playlist-sounds.plain`. Any module that injects additional rows into the Currently Playing widget will be constrained by the same max-height (`clamp(200px, 40vh, 480px)`) and scrolled by the same amber scrollbar. That is usually fine but may surprise modules expecting the panel to grow unbounded.
- **Defines new click targets via `data-sos-action`** (e.g. `soundscapeFireNow`, `soundscapeStopAll`, `cyclePlaylistMode`, `toggleLoop`). A global click listener on the playlist directory handles these; modules that add their own delegated `click` listeners should scope them so they do not intercept SoS's attributes.
- **Uses the `--sos-*` CSS custom property prefix.** No collision risk with other modules' variables unless they also use `--sos-*`.

If you need another module's Currently Playing UI instead of SoS's, disable SoS's Currently Playing — currently that means disabling SoS itself; a future release may expose a "leave Currently Playing alone" setting if there is demand.

### Other Modules
No known conflicts with non-playlist modules. If you find a compatibility issue, please [open an issue](https://github.com/GnollStack/The-Sound-of-Silence/issues).

---

## Roadmap

- [ ] Cross-playlist crossfading (fade from Exploration to Combat playlists)
- [ ] Intro-to-playlist linking (play intro track, then auto-switch to looping playlist)
- [ ] Preset system (save/load/share loop configurations)
- [ ] Playlist automation triggers (on combat start, on scene change)
- [ ] Non-sequential segment playback (jump between segments in any order)

---

## Community

- [Report Bugs](https://github.com/GnollStack/The-Sound-of-Silence/issues) — help improve the module with detailed reproduction steps
- [Request Features](https://github.com/GnollStack/The-Sound-of-Silence/issues) — if it's within scope and feasible, there's a good chance it'll get built
- Star this repo if you find it useful

---

## ⚖️ License & Permissions

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
For licensing inquiries or permission slips:
* **Discord:** `GnollStack` (Preferred)
* **Email:** `Somedudeed@gmail.com`
* *Please do not open GitHub Issues for commercial licensing discussions. But feel free to contact me via Discord or Email*

Please do not open GitHub issues for commercial licensing discussions.

---

**Author:** [GnollStack](https://github.com/GnollStack)
**Compatibility:** Foundry VTT v13+ verified through v14.360

---

<div align="center">

[⬆ Back to Top](#the-sound-of-silence)

</div>
