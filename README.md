<div align="center">

# The Sound of Silence

**Loop your music, fade between tracks, and build ambience for your Foundry games.**

[![Latest Release](https://img.shields.io/github/v/release/GnollStack/The-Sound-of-Silence?label=Latest%20Release&style=flat-square)](https://github.com/GnollStack/The-Sound-of-Silence/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/GnollStack/The-Sound-of-Silence/the-sound-of-silence.zip?label=Downloads&style=flat-square&color=green)](https://github.com/GnollStack/The-Sound-of-Silence/releases)
[![Latest Downloads](https://img.shields.io/github/downloads/GnollStack/The-Sound-of-Silence/latest/the-sound-of-silence.zip?label=Latest%20Downloads&style=flat-square)](https://github.com/GnollStack/The-Sound-of-Silence/releases/latest)
[![Foundry VTT v13–v14](https://img.shields.io/badge/Foundry-v13--v14-orange?style=flat-square)](https://foundryvtt.com)
[![Ko-fi](https://img.shields.io/badge/Ko--fi-Buy%20a%20Steak-FF5E5B?style=flat-square&logo=ko-fi&logoColor=white)](https://ko-fi.com/gnollstack)
[![Patreon: Bazaar Patron](https://img.shields.io/badge/Patreon-Bazaar%20Patron-F96854?style=flat-square&logo=patreon&logoColor=white)](https://www.patreon.com/cw/GnollStack)
[![Discord: Bakshi's Bazaar](https://img.shields.io/badge/Discord-Bakshi%27s%20Bazaar-5865F2?style=flat-square&logo=discord&logoColor=white)](https://discord.gg/bGQDnyqYJ)

*For GMs who want music to help tell a story.*

[Preview](#preview) · [Quick Start](#quick-start) · [Features](#features) · [Use It For](#use-it-for) · [Installation](#installation) · [Compatibility](#compatibility) · [API](#developer-api) · [Bakshi's Bazaar](#bakshis-bazaar) · [Roadmap](#roadmap) · [Community](#community) · [Contributing](#contributing) · [AI Use](#ai-use) · [Support](#support-development) · [License](#license-permissions)

</div>

---

<div align="center">

## Feature Index

| Feature | What it does |
| :--- | :--- |
| **[Internal Loops](#internal-loop-sequencer)** | Keep the best part of a track running until the scene changes. |
| **[Crossfading](#auto-crossfade)** | Blend one track into the next. |
| **[Silence Gaps](#silence-gaps)** | Leave a little space between songs. |
| **[Soundscape](#soundscape-mode)** | Mix background ambience with occasional sounds, such as birds or thunder. |

*SoS works on Foundry's own playlists. The GM sets up loops, fades, and soundscapes, and connected players hear the same playback.*

</div>

---

<div align="center">

<a id="preview"></a>

## Preview

</div>

<div align="center">

<img width="375" height="252" alt="Currently Playing transport controls" src="https://raw.githubusercontent.com/GnollStack/Bakshi-s-Bazaar-Media/main/the-sound-of-silence/images/the-sound-of-silence-currently-playing.png" />

</div>

---

<div align="center">

<a id="quick-start"></a>

## Quick Start

</div>

1. Install and enable **The Sound of Silence** in your world.
2. Open the **Playlists** sidebar and expand any playlist.
3. Use the buttons beside the playlist name to turn silence gaps or crossfading on and off, or to choose a playback mode.
4. Right-click a playlist or sound and choose **Configure** to set up loops, fades, and Soundscape options.

<div align="center">

<img width="397" height="751" alt="Playlist configuration settings" src="https://raw.githubusercontent.com/GnollStack/Bakshi-s-Bazaar-Media/main/the-sound-of-silence/images/the-sound-of-silence-playlist-config.png" />

</div>

---

<div align="center">

<a id="features"></a>

## Features

</div>

<a id="internal-loop-sequencer"></a>

### Internal Loop Sequencer

**Let the intro play, repeat the part you want, then move on when you're ready.**

Choose up to 16 loop sections in one track without editing the audio file. Drag the handles to set each section, preview how the joins sound, and use the playback controls to break out of a loop during the game.

<div align="center">

<img width="444" height="564" alt="Internal loop editor" src="https://raw.githubusercontent.com/GnollStack/Bakshi-s-Bazaar-Media/main/the-sound-of-silence/images/the-sound-of-silence-loop-editor.png" />

▶ **[Watch demo (2 min)](https://youtu.be/ykLuKt_UPlg)**

</div>

---

<a id="auto-crossfade"></a>

### Auto Crossfade

SoS uses equal-power crossfades to help keep the volume steady while one track fades out and the next fades in. Use the playlist's fade-out time or choose a separate crossfade duration.

If you pause during a crossfade, playback resumes on the incoming track. For longer fades, SoS starts loading the next track early so it has time to get ready.

▶ **[Watch demo (1 min)](https://youtu.be/7K72lde_jus)**

---

<a id="silence-gaps"></a>

### Silence Gaps

Set a fixed pause between tracks, or a minimum and maximum length and let SoS choose each time. Silence gaps work in Sequential, Shuffle, and Simultaneous modes.

▶ **[Watch demo (1 min)](https://youtu.be/qWQ8Ci46iiw)**

---

<a id="soundscape-mode"></a>

### Soundscape Mode

Loop a steady background, such as rain, then add sounds that play now and then, such as thunder or a creaking branch. Choose how often they play, where they sit between the left and right speakers, and how many can overlap. By default, the GM controls these sounds and players hear the same events.

<div align="center">

<img width="373" height="563" alt="Soundscape procedural roster and preview controls" src="https://raw.githubusercontent.com/GnollStack/Bakshi-s-Bazaar-Media/main/the-sound-of-silence/images/the-sound-of-silence-soundscape-roster.png" />

</div>

---

### More Details

<details>
<summary><strong>More about internal loops</strong></summary>

- Add up to 16 sections, each with its own start, end, crossfade time, and repeat count.
- Choose what happens after a section: skip to the next, keep playing, or fade out.
- Skip the intro and fade straight into the first loop section.
- Adjust sections on a color-coded timeline and see where crossfades overlap.
- Preview a whole loop or just the join. The preview starts at the sound's saved volume.
- Use **Currently Playing** to break a loop, jump to the previous or next section, or turn loops off.
- Section controls still work between loops and after you press **Break**.
- Finished loops are cleared so they no longer appear as active in the API.

</details>

<details>
<summary><strong>More about crossfading</strong></summary>

- Equal-power blending helps keep the change in volume smooth.
- Use the playlist's fade-out time or set a separate duration.
- Fade curves control how the volume rises and falls.
- Crossfades work when tracks advance on their own or you skip manually, and stay in sync for connected players.

</details>

<details>
<summary><strong>More about silence gaps</strong></summary>

- **Static:** use the same pause every time.
- **Random:** choose a pause between your minimum and maximum.
- Available in Sequential, Shuffle, and Simultaneous playback.

</details>

<details>
<summary><strong>More about Soundscape</strong></summary>

Choose **Soundscape** from the playlist's playback-mode picker. It appears alongside Soundboard, Sequential, Shuffle, and Simultaneous.

- **Background tracks (beds):** loop continuously. Start them together with **Play All** or individually.
- **Occasional sounds (procedurals):** use Uniform Random, Fixed Cadence, or Natural timing. Natural timing favors delays near the middle of your range.
- **First sound:** wait for the normal timing, stagger the first sounds, or play them immediately.
- **Overlapping sounds:** set a limit, called the polyphony cap. Independent, Linear, and Soft options control how play chances respond as the mix gets busier.
- **Groups:** give related sounds a shared limit and a cooldown after a sound finishes.
- **Player sync:** players hear the GM's chosen sounds with the same timing, stereo position, variations, and fades. Players can switch to their own random timing; background tracks and playlist controls still stay synced.
- **Preview:** listen to the full mix from the playlist or try one sound from its configuration sheet. Only you hear previews, and they don't change live playback.
- **Individual controls:** play or stop any sound. The playlist stops when its last sound ends.
- **Procedural Roster:** see each sound's timing, first-play behavior, play chance, and stereo position in one table.
- **Fire Now:** the GM can click the lightning-bolt button to trigger a sound. During live playback, players hear it too. It skips the group cooldown for testing but still respects overlap limits.

</details>

<details>
<summary><strong>Currently Playing controls</strong></summary>

- See the playlist name and current track together.
- Control repeat, silence, crossfade, loops, playback mode, previous/next, pause/resume, and Stop.
- Adjust track and playlist volume with separate sliders.
- See fade-in and fade-out sections marked in gray on the progress bar.
- Keep loop controls available between sections and after **Break**.
- Expand Soundscape groups, see how many sounds are playing, or stop a whole group.
- Scroll within the panel while keeping the playlist list within reach.
- Keep your place in the playlist list when a track changes.

</details>

<details>
<summary><strong>Shuffle, fades, and volume</strong></summary>

- **Shuffle:** choose Foundry Default, Exhaustive, Weighted Random, or Round-Robin.
- **Fade-in:** choose Logarithmic, Linear, S-Curve, or Steep in the world settings.
- **Fade-out:** control how the volume falls as a sound ends.
- **Volume normalization:** set a target for each playlist and exclude individual sounds when needed.
- **Playlist looping:** repeat the playlist with silence gaps or crossfades still in place.

</details>

<details>
<summary><strong>Playback controller and co-DMs</strong></summary>

Open **Configure Settings > The Sound of Silence > Configure Playback Controller** as a full GM.

- **Automatic — prefer full GM** gives connected full GMs priority over assistants. Accounts with the same role use a stable selection order.
- Choose a **Preferred Playback Controller** to delegate automatic playback to a particular GM or assistant. Offline accounts remain available in the list.
- Use **Excluded Playback Controllers** to keep bridge or automation accounts from running SoS automation. An account cannot be preferred and excluded at the same time.

Changes apply during playback without a reload. If the preferred account is unavailable, another eligible full GM takes over, followed by an assistant. The preferred account takes over again when it returns. With no eligible controller, local playback continues and SoS waits to author new automatic transitions.

These settings do not change anyone's manual playback permissions. Controller selection and handoff details appear only when **Enable Debug Logging** is on.

</details>

<details>
<summary><strong>Troubleshooting</strong></summary>

If you're tracking down a playback problem, **Trace Currently Playing Timers** adds timing details to the logs across clients.

GMs can compare what's happening on their own client and connected players' clients:

```javascript
game.modules.get('the-sound-of-silence').api.requestClientDiagnostics()
```

After about three seconds, a dialog shows volume, fades, audio readiness, and playback timing for each client. Red highlights possible problems; amber marks active fades.

To update old loop setups, open **Configure Settings → The Sound of Silence → Migrate Legacy Internal Loops**. This permanently converts older loop settings to the current segment format after you confirm. Back up your world first and stop all playlists. Existing segment-based loops are left alone.

> [!WARNING]
> If the GM controls playback, setting Music Volume to exactly `0` and switching away from the tab can stall the audio clock. Keep it at `0.01`, or mute the browser tab or app instead.

</details>

<details>
<summary><strong>Diagnostics (MCP Bridge)</strong></summary>

For the **Foundry MCP Bridge**, turn on **Enable Debug Logging** and **Enable MCP Diagnostics**, then use its module action tool. These tools are for GM troubleshooting and testing; leave MCP Diagnostics off during normal play. For example:

```javascript
call-module-debug-action({
  moduleId: "the-sound-of-silence",
  action: "getStatus",
  args: {}
})
```

The built-in inspection tools check settings, assets, playback, and connected clients. They are GM-only, off by default, and do not create world documents. The available actions under `api.diagnostics.actions` are `getStatus`, `validateSettings`, `validateAssets`, `collectClientDiagnostics`, `runSmokeTests`, `openWindow`, `parseText`, `validateText`, and `refreshClient`.

- **Status:** `getStatus` shows which permissions and settings are enabled, along with audio readiness. Click inside each game client to unlock audio before testing playback.
- **Client reports:** use `collectClientDiagnostics` to compare clients. Add `playlistIds` to focus on particular playlists.
- **Refresh:** `refreshClient` needs `confirmRefresh: true`. Use `scope: "client"` for the current client or `scope: "world"` for all connected clients. World refresh also requires permission to change world settings. The bridge's `reload-foundry-client` tool is also available for a full reload.

Automated playback tests belong in a dedicated test world. They require **Enable MCP Diagnostics** and `confirmMutation: true`, and use short test tones to check fades, shuffle, loops, silence, soundscapes, and player sync.

- Use `runAutomation` and `cleanupFixtures`, or the specific actions `controlPlayback`, `runPlaybackAutomation`, `runClientSyncAutomation`, and `cleanupPlaybackFixtures`.
- Multiplayer tests normally need at least one connected player. Missing client responses or missing playback on an audio-ready client fail the check. Locked audio makes playback checks inconclusive.
- Cleanup removes only marked SoS test documents whose names start with `SoS MCP Test -`. Supply `runId` to limit cleanup to one test run.

</details>

---

<div align="center">

<a id="use-it-for"></a>

## Use It For

</div>

| At the table | Try this |
| --- | --- |
| **Boss battles** | Give each phase its own loop, then press Break when the fight changes. |
| **Atmosphere** | Keep rain, wind, wildlife, or tavern sounds going while you run the game. |
| **Quiet moments** | Leave a pause between songs or gently fade into the next track. |
| **Favorite tracks** | Loop the parts you want to hear again. |

<details>
<summary><strong>Example: music for a boss fight</strong></summary>

```text
Segment 1  00:00–01:30   Intro      loop 1×, skip to next
Segment 2  01:30–03:00   Phase 1    loop ∞
Segment 3  03:00–04:45   Phase 2    loop ∞
Segment 4  04:45–06:00   Victory    loop 1×, play through
```

The intro plays once, then Phase 1 loops. Press **Break** when the boss enters Phase 2. Press it again when the boss falls, and the victory section plays once before the track ends.

</details>

<details>
<summary><strong>Example: a rainy forest</strong></summary>

| Track | Type | Settings |
| --- | --- | --- |
| Forest Bed | Background | Repeat on |
| Wind Gust | Occasional sound | Uniform Random, 10–25 seconds, random stereo position |
| Bird Call | Occasional sound | Natural, 6–18 seconds, 70% play chance |
| Branch Creak | Occasional sound | Every 30 seconds, stagger the first sound |

</details>

---

<div align="center">

<a id="installation"></a>

## Installation

</div>

1. From Foundry's setup screen, open **Add-on Modules → Install Module**.
2. Search for "Sound of Silence" or paste this manifest URL:

```text
https://github.com/GnollStack/The-Sound-of-Silence/releases/latest/download/module.json
```

3. Install **libWrapper** if needed, then enable both modules in your world.

| Requirement | Version |
| --- | --- |
| Foundry VTT | v13–v14; verified on 14.367 |
| [libWrapper](https://github.com/ruipin/fvtt-lib-wrapper) | Required; 1.13.3.0 or newer, tested with 1.13.5.1 |

---

<div align="center">

<a id="compatibility"></a>

## Compatibility

</div>

**Foundry VTT:** v13–v14; verified on **14.367**. Earlier releases were tested on v13.351, and v13 hasn't been retested for this update.

**Game systems:** works in any system; tested in **dnd5e 5.3.3**.

**Browsers:** Chrome/Chromium and Firefox. The latest tests used Chrome 153; earlier releases were also tested with Opera GX and Firefox. Click inside the game on each client to unlock audio before playing.

> [!TIP]
> For the simplest setup, use SoS on its own for playlists and audio. Keep Monks Sound Enhancements or Playlist Enchantment only if you need their other features, such as actor sounds, audio uploads, or previews.

<details>
<summary><strong>Monks Sound Enhancements</strong></summary>

**Module ID:** `monks-sound-enhancements` · Can be used alongside SoS, with some overlap.

**SoS takes over:** the Currently Playing panel, playlist settings, and sound-effect volume slider.

**Features you can keep:** actor and token sounds, `@Sound[]` links, combat-turn sounds, dragging sounds between playlists, hotbar macros, playlist tooltips, and hiding names or playlists.

</details>

<details>
<summary><strong>Playlist Enchantment</strong></summary>

**Module ID:** `playlistenchantment` · Can be used alongside SoS, with some overlap.

**SoS takes over:** the Currently Playing panel, volume normalization, fades, playlist looping, and the controls to play, stop, or skip all playlists.

**Features you can keep:** dragging files in to upload audio, prehear previews, hotbar macros, and the hotbar hover popup.

> [!WARNING]
> Turn off Enchantment's `alwaysFade` setting to avoid conflicting fades. SoS includes a guard for it, but disabling it is the simplest way to avoid overlap.

</details>

<details>
<summary><strong>Notes for other module authors</strong></summary>

SoS replaces `PARTS.playing` during the `ready` hook. It uses `sos-sound-partial.hbs` and `sos-soundscape-group.hbs` to display sound rows.

Foundry's selectors (`.sound[data-sound-uuid]`, `.current`, `.duration`, `.pause`) remain available through hidden elements for compatibility. SoS styles use the `--sos-*` prefix, and buttons use `data-sos-action`. Scrolling over a volume control adjusts that control without scrolling the panel.

</details>

---

<div align="center">

<a id="developer-api"></a>

## Developer API

</div>

For macros and other modules, start with:

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
<summary><strong>Settings and playback status</strong></summary>

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
<summary><strong>Troubleshooting and helpers</strong></summary>

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

**Fade the playing track into the next one.** Change `"Combat"` to your playlist's name.

```javascript
const api = game.modules.get("the-sound-of-silence").api;
const playlist = game.playlists.getName("Combat");
const current  = playlist?.sounds.find(s => s.playing);
if (!playlist || !current) return ui.notifications.warn("Nothing playing.");

await api.crossfadeToNext(playlist, current);
```

**Break all active loops.** Put this on your hotbar to move the music on when a boss changes phase.

```javascript
const api = game.modules.get("the-sound-of-silence").api;
const looping = api.getAllLoopingSounds();
if (!looping.length) return ui.notifications.info("No active loops.");

for (const sound of looping) api.breakLoop(sound);
ui.notifications.info(`Broke ${looping.length} loop(s).`);
```

**Compare playback across clients.** GMs can run this to open a comparison of their client and connected players after about three seconds.

```javascript
game.modules.get("the-sound-of-silence").api.requestClientDiagnostics();
```

**Turn Soundscape mode on or off.** Change `"Rainy Forest"` to your playlist's name.

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

<div align="center">

<a id="bakshis-bazaar"></a>

## Bakshi's Bazaar

*The Sound of Silence is free. My premium modules are released as **Bakshi's Bazaar** for [Bazaar Patrons](https://www.patreon.com/cw/GnollStack) and install through Foundry's Premium Content.*

</div>

| Module | What it adds |
| --- | --- |
| **[5e Activity Importer](https://foundryvtt.com/packages/5e-activity-importer)** | Adds activities and Active Effects to dnd5e Items from YAML, or imports complete Items together with 5e Item Importer. |
| **[Custom Currency 5e](https://foundryvtt.com/packages/custom-currency-5e)** | Custom coins, exchange rates, regional markets, and physical coin items on native dnd5e sheets. |
| **[FileSmith](https://foundryvtt.com/packages/filesmith)** | Folder colors, multi-select, clipboard actions, and move undo for Foundry's sidebar. |
| **[Immersive Vision FX](https://foundryvtt.com/packages/immersive-vision-fx)** | Soft vision and light edges, creature vision profiles, cave light, and eyeshine. |
| **[Traffick](https://foundryvtt.com/packages/traffick)** | Party trading, merchant catalogs, perceived prices, and appraisal checks for dnd5e. |

A Bazaar Patron membership includes:

- Every Bakshi's Bazaar premium module while your membership is active, including ongoing updates and new modules as they're added.
- Patron-only channels in the [Bakshi's Bazaar Discord](https://discord.gg/bGQDnyqYJ).
- Priority module support.
- A direct place to share feedback and feature suggestions. Suggestions are welcome and taken seriously, but development priorities remain at my discretion.

Everyone is welcome in the [Bakshi's Bazaar Discord](https://discord.gg/bGQDnyqYJ): the public channels cover release announcements, questions, and feature ideas, and patrons also get the patron-only channels and priority support. Bug reports for The Sound of Silence still go to [GitHub issues](https://github.com/GnollStack/The-Sound-of-Silence/issues), as described under Community.

---

<div align="center">

<a id="roadmap"></a>

## Roadmap

</div>

| Item | What it unlocks |
| --- | --- |
| **Cross-playlist crossfading** | Fade from Exploration → Combat without manually stopping the first playlist. |
| **Intro-to-playlist linking** | Play a one-shot intro track, then auto-switch into a looping playlist. |
| **Preset system** | Save, load, and share loop configurations between worlds and GMs. |
| **Automation triggers** | Fire on combat start, scene change, or arbitrary hook conditions. |
| **Non-sequential segments** | Jump between loop segments in any order, not just forward. |

---

<div align="center">

<a id="community"></a>

## Community

</div>

- **Report bugs** — [open an issue](https://github.com/GnollStack/The-Sound-of-Silence/issues) with your Foundry version, module version, steps to reproduce, console logs, and screenshots or short clips when useful.
- **Ask on Discord** — anyone can ask questions in the public channels of the [Bakshi's Bazaar Discord](https://discord.gg/bGQDnyqYJ). Bazaar Patrons get priority support in the patron-only channels.
- **Request features** — tell me what happened at your table and what you wish the module could do.
- **Star the repo** — if the module is useful at your table, a star helps other GMs find it.
- **Watch releases** — follow the repo for updates, compatibility notes, and new feature releases.

---

<div align="center">

<a id="contributing"></a>

## Contributing

</div>

Bug reports, feature ideas, reproduction notes, documentation fixes, and localization ideas are welcome.

I am not generally accepting unsolicited code PRs for features, refactors, architecture, or behavior changes. This is still my module and my codebase; I will decide how features are designed and implemented unless I explicitly say otherwise.

- **Bug reports** — include Foundry version, module version, a console log, and the steps to reproduce. Screenshots or short clips help a lot.
- **Feature requests** — tell me what happened at your table and what you wish the module could do.
- **Pull requests** — please do not open code PRs unless I ask for one. Open an issue with the idea instead.
- **Code ownership** — core implementation, architecture, and release decisions remain with me unless stated otherwise.
- **Translations and docs** — typo fixes, wording suggestions, and localization ideas are welcome by issue first. I do not have a public translation setup yet, so I will fold useful wording in myself.

I may adapt, decline, or implement submitted ideas. Any accepted contribution or submitted project material may be released under the same EULA as the rest of the module.

---

<div align="center">

<a id="ai-use"></a>

## AI-Assisted Development

</div>

This module is developed and maintained with the help of AI-assisted tools for coding, debugging, and testing.

I care about the quality, behavior, performance, security, and long-term maintainability of this module, and I take full responsibility for what ships. AI assistance does not replace review, testing, debugging, or security and design judgment.

AI is used here as a tool under my direction to make Foundry better and allow for long term mod support while still having a life outside of building and maintaining my free and premium modules.

If you are uncomfortable using software developed with AI-assisted tools, this module is not for you.

---

<div align="center">

<a id="support-development"></a>

## 🥩 Support Development

This module represents **many hours** of development.

**If this module enhanced your immersion, consider treating me to a steak, much better than coffee!**

<a href='https://ko-fi.com/gnollstack' target='_blank'>
<img height='36' style='border:0px;height:36px;' src='https://storage.ko-fi.com/cdn/kofi3.png?v=3' border='0' alt='Buy Me a Steak at ko-fi.com' />
</a>

> *"Thanks for the support! It helps me maintain support for the module and puts a nice steak on the table."*

</div>

---

<div align="center">

<a id="license-permissions"></a>

## ⚖️ License & Permissions

</div>

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

**Author:** [GnollStack](https://github.com/GnollStack) · **Compatibility:** Foundry VTT v13 - v14

[⬆ Back to Top](#the-sound-of-silence)

</div>
