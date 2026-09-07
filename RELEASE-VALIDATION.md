# 14.15.3 release candidate validation

Validation dates: September 4-7, 2026. The September 7 browser matrix below supersedes earlier pending browser and multiplayer checks.

This is a compatibility and maintenance patch. Release approval remains pending the checks below; a tested Foundry build does not imply every browser or multiplayer combination was verified.

## Changes

- Corrected sound configuration's namespace read: `Document.getFlag` requires both scope and key. The form now reads the existing module flags directly, preserving explicit procedural defaults in submitted data and making error recovery use the previous configuration.
- Limited diagnostics stop/cleanup operations to marked fixtures in the current world and run. Unrelated playlists and other test runs are no longer stopped by automation preflight.
- Added Node regression tests for those boundaries and real Foundry configuration-sheet render/submit checks, including all 16 loop segments.
- Replaced a fixed fade-test sleep with a bounded wait for Web Audio cleanup and removed assertions that could pass without media.
- Synchronized package versions at 14.15.3, pinned the uppercase `V14.15.3` download URL, declared the documented libWrapper minimum, and pointed the license field to the shipped EULA.
- Recorded the tested Foundry build and corrected stale README version/browser claims. Runtime load order, public APIs, flags, and audio architecture are preserved.

## Environment and evidence

- Connected Foundry MCP GM client: **Foundry 14.367**, **dnd5e 5.3.3**, **libWrapper 1.13.5.1**.
- Tests exercised edited files after browser reload. The running server retains its startup manifest version, 14.15.2; final 14.15.3 installation/server restart verification is still required.
- `npm test`: **93 passed**, no failures or skips.
- `npm run check:syntax`: **55 JavaScript files passed**.
- Private maintenance validation: **0 failures**; remaining warnings concern the pending release tag and existing audio/timer patterns requiring review.
- Foundry diagnostics: **12 smoke tests passed**, **10 settings validated**, **16 diagnostic assets fetched successfully**.
- Packaging rehearsal: **267 asset/import checks passed**. A candidate archive contains **66 files**, identical standalone/embedded manifests, all runtime imports/templates/styles and the EULA, and no private or development files. It is a working-tree rehearsal, not the final tagged release archive.
- Configuration sheets rendered SoS controls and persisted submitted fields through native Foundry submission. A 16-segment internal loop survived the sound-sheet save.

| Foundry playback scenario | Passed assertions |
| --- | ---: |
| Basic play/advance/stop document state | 3 |
| Crossfade with live source media | 4 |
| Pause/resume during crossfade | 6 |
| Early crossfade preload | 4 |
| Silence completion, looping, terminal stop, Previous/Next cancellation | 21 |
| Zero-duration transition fallback | 4 |
| Configuration boundaries and sheet submission | 15 |
| Internal loop, retirement, pause/resume, skip-intro media identity | 12 |
| Legacy loop crossfade | 4 |
| Fixture-scoped legacy loop migration | 9 |
| Soundscape start/stop | 3 |
| Advanced soundscape, panner cleanup, polyphony | 14 |
| Soundscape groups and cooldowns | 5 |
| Shuffle patterns | 26 |
| Custom fade curves, live gain, token cleanup and stop | 29 |

Total: **15 scenarios, 159 assertions passed**.

Live audio assertions ran with unlocked, running 48 kHz audio contexts. The initial basic/silence checks also exercised document behavior while audio was locked; silence subsequently passed again with audio unlocked. Document-state checks alone are not proof of audible playback.

The custom-fade scenario initially passed 28/29 assertions: all four curve selections, useful gain, fade-out and stop checks passed, but first-use fade-token cleanup missed a fixed 220 ms wall-clock check. The diagnostic now waits up to one second for the Web Audio completion event. Its post-change, unlocked live rerun passed all 29 assertions. A locked-audio attempt exceeded the bridge query timeout and subsequently cleaned up its fixtures before the successful rerun.

All fixture playlists and folders were removed. World document counts returned to the initial 17 playlists, 393 playlist sounds, and 27 folders; actor/item/journal/scene counts were unchanged. Temporarily changed shuffle and fade settings were restored. Post-playback captured console errors and warnings were empty. Startup separately reported a Foundry window narrower than its 1024 px requirement.

## Source review

Reviewed the installed 14.367 Sound, AudioTimeout, Playlist, PlaylistSound, playlist directory, configuration sheets, document flags, and package schema at the wrapped boundaries. No additional removal of an API used by SoS was found there.

Reviewed official [14.364](https://foundryvtt.com/releases/14.364), [14.365](https://foundryvtt.com/releases/14.365), [14.366](https://foundryvtt.com/releases/14.366), and [14.367](https://foundryvtt.com/releases/14.367) release notes, plus [dnd5e 5.3.3](https://github.com/foundryvtt/dnd5e/releases/tag/release-5.3.3). The dnd5e patch does not require system-specific changes in this playlist/audio module.

## Remaining release checks

- Run all client-sync scenarios with at least one unlocked player client. The responder preflight correctly reported zero connected players; multiplayer was not verified in this pass.
- Listen for clicks, clipping, and smooth transitions on Chromium and Firefox, including long streamed tracks, background-tab recovery, and repeated automatic transitions. Automated gain/state checks cannot establish listening quality.
- Visually inspect dark/light themes, scrolling and wheel controls, preview/audition, and detached windows at a supported window size. Configuration rendering/submission passed; visual QA was not available through the browser connection.
- Rerun Monks Sound Enhancements and Playlist Enchantment integration checks if claiming current support. Both were inactive in the test world. Retest v13 before extending historical v13 results to this patch.
- Commit the reviewed release changes, tag the final commit `V14.15.3`, build the final archive from that tag, and validate a clean installation. Verify the standalone and embedded manifests match and both exact-version release assets are available before publishing/announcing.

The strict release check currently reports exactly these two preparation blockers: uncommitted release changes and the absent `V14.15.3` tag. The ordinary maintenance check passes. No existing release tag or public asset was changed.

The candidate has not been committed, tagged, or published by this validation pass.

## September 6 GM/player regression follow-up

Environment: Foundry 14.367, dnd5e 5.3.3, module manifest 14.15.3, one GM and one TestUser player. Both clients reported running 96 kHz audio contexts. The player initially had master playlist volume zero; live checks were repeated after the user raised it.

Four runtime issues were reproduced and fixed:

- An in-flight natural silence advancement could overwrite a later Play/Stop command. Cancellation now waits for that update before applying the command. Stop also includes media activated during that wait, preserves its stopping latch, and clears the recreated playback clock.
- Native playback could use a different effective offset from PlaybackClock after a pause. The clock now reads the position actually established by native playback without changing its options or paused time. The installed native methods were exercised through the wrapper: paused 20 + explicit offset 80 produces playback/clock 100; explicit 0 produces 20; a native loop bound of 90 produces 90. Missing clock inputs fall through without treating null as zero.
- An uncached sound finishing its first load after Stop could evade document lookup because its playlist was already stopped. Lookup now includes stopped playlists and rejects delayed autoplay before native playback begins.
- A first playback-clock save already in flight could finish after Stop cleared the clock and leave stale metadata behind. Clock saves and clears now run in request order per playlist. Stop drains earlier writes, a later Play retains its newer clock, failures do not block subsequent commands, and queued mutations recheck GM authority. Playback timestamps are captured at request time.

Regression coverage includes successful/rejected pending silence updates, Play/Stop, terminal-hook re-entry, local and replicated Stop targets, explicit native/clock offset precedence, Stop before first load finishes, Stop while native play is pending, and ordinary soundboard/unmanaged playback.

`npm test`: **109 passed**, no failures or skips. Syntax: **57 JavaScript files passed**. Private maintenance validation: **0 failures**, five existing warning groups. Diagnostics now reject missing preflight clients and unexpected extra media, resample Stop completion, and select crossfade fixtures by actual playback order. New multiplayer scenarios cover silence completion/cancellation and rapid start/stop. Clock ordering tests cover delayed first writes, later same-track Play, rejected writes, authority loss, and native-style synchronous hook re-entry.

All 15 existing playback scenarios passed during earlier parts of the session. All 14 existing multiplayer scenarios and the new silence replication scenario also produced successful runs; the initial muted-player checks were superseded by unlocked live-media checks. Those runs span revisions and do not establish final-code multiplayer validation.

After a native world refresh, both GM and TestUser had new client instance/socket identities and unlocked audio. Basic playback (3 assertions), crossfade (4), and pause/resume transitions (6) passed again. The preload scenario then failed all four readiness assertions, and the silence scenario disconnected the GM. Preload already uses explicit four-second clips and actual playback order, so neither the generic tone pool nor fixed-name selection explains that failure; bounded media, context, order, and preload evidence has been added for its next run. The interrupted silence fixture was removed, restoring the original document counts. Further live playback is paused pending a GM comparison in Chrome or Edge while the Foundry application continues hosting the world.

### Renderer crash investigation — unresolved

Final verification remains in progress. During repeated transition-fallback checks, the GM view became grey/black and the developer console disconnected. Process inspection observed renderer PID replacement across crash/recovery while other Foundry processes remained; it did not capture a native exit code or crash stack. Recoveries stopped and removed the interrupted fixtures, returning the world to 17 playlists, 393 sounds, and 27 folders. Both clients subsequently refreshed, but final-code GM/player checks still require stable completed runs; the earlier successes span revisions and do not clear the release.

The renderer failure is not yet conclusively attributed. A separate defect was reproduced in the installed Foundry 14.367 `AudioBufferCache`: with a 100-byte limit and 100 simulated 16-byte buffers, the cache reported 96 bytes while its Map retained all 100 entries (1,600 bytes). Its expiry path removes LRU accounting but does not remove Map entries. Deleting already-expired entries can also damage accounting, so the module does not attempt bulk cache deletion. Routine fixtures now use a bounded pool of short tones; explicit-duration tests retain their own short clips. Read-only telemetry reports cache accounting, retained entry bytes, and JavaScript heap usage.

The crash reproduced immediately after a fresh reload with an empty audio cache and roughly 115 MB JavaScript heap. Accumulated campaign buffers are therefore not sufficient to explain this reproduction. The isolated results are:

| Fixture comparison | Observed result |
| --- | --- |
| Setup only; load/decode only | Passed without playback |
| Crossfade fallback alone; silence fallback alone | Each passed |
| Both fallback halves using manual stop/end callbacks | Renderer exited; one durable marker was `silence.document-end:after`, with target media state 4, time 0, duration 1.2 s |
| Both fallback halves using actual natural track endings | Renderer exited |
| `nativeReplay`: replay the same media twice with crossfade and silence disabled | Renderer exited while waiting for the second natural ending to advance the target document/media |
| Restrict the SoS `Sound.stop` cancellation hook to module-owned fades | Still crashed in `nativeReplay`; experimental change reverted |
| Cancel native zero-duration fade-out scheduling | Still crashed in `nativeReplay`; experimental change reverted |

The features-disabled comparison still loads SoS wrappers. These observations do not conclusively attribute the failure to Foundry core, Chromium, or the module. Durable stage markers bound where the awaited operation was interrupted; they are not a native crash stack. The two unsuccessful experimental runtime changes are not included in the candidate.

For a controlled reproduction, call the MCP `call_module_debug_action` tool with the following payload. This requires the GM diagnostics gates and creates only marked fixtures for the supplied run ID. Keep `cleanupAfter: false` so the durable marker survives a renderer exit. Run one comparison at a time.

```json
{
  "moduleId": "the-sound-of-silence",
  "action": "runPlaybackAutomation",
  "args": {
    "confirmMutation": true,
    "runId": "renderer-repro-native",
    "scenarios": ["transitionFallbacks"],
    "transitionFallbackPhase": "nativeReplay",
    "transitionFallbackEnd": "natural",
    "cleanupAfter": false
  }
}
```

For the combined reproduction, use phase `all`; use end mode `natural` or `manual` and a distinct run ID for each comparison. Isolation phases are `setup`, `load`, `crossfade`, and `silence`. Do not rerun an interrupted run before collecting its marker: default preflight cleanup removes fixtures with that run ID.

After a crash, manually reload the GM and reconnect the bridge, then call `getStatus` and save its `fixtureStages` entry for the run before cleanup:

```json
{"moduleId":"the-sound-of-silence","action":"getStatus","args":{}}
```

Finally, stop and remove only that run's marked fixtures. Use the same run ID as the reproduction:

```json
{
  "moduleId": "the-sound-of-silence",
  "action": "cleanupPlaybackFixtures",
  "args": {
    "confirmMutation": true,
    "runId": "renderer-repro-native",
    "stopFirst": true
  }
}
```

### September 6–7 browser comparison — verification continues

The GM moved from the Foundry application's Electron client (Chromium 146, 96 kHz audio) to Chrome 152 with 48 kHz audio. In Chrome, `nativeReplay` passed 2 assertions, combined transition fallback passed 4, preload passed 4, and silence passed 21. The pending-clock-write fix was also loaded before these runs, so the comparison changes both runtime code and client environment; it does not isolate a crash cause.

The user then reported that the Electron client also crashed while logged in as TestUser, with the GM still in Chrome. Around 00:00 September 7 (America/Denver), process inspection showed that all Foundry processes had restarted. The Chrome GM's socket loss coincided with that application/server restart and is not evidence of a Chrome renderer crash.

The next comparison used browser clients for both GM and TestUser, leaving the Foundry application at the join screen to host the world. Its completed results follow. These Chrome successes and the Electron player failure do not conclusively attribute the crash to Foundry core, Chromium/Electron, audio sample rate, or SoS.

## September 7 final browser regression matrix

All playback runtime fixes were loaded in both clients before this matrix. The GM and TestUser had distinct, refreshed browser instance/socket identities, three unlocked running 48 kHz audio contexts each, and master playlist volume 0.5. Both identities remained unchanged through postflight. Foundry 14.367 hosted module 14.15.3 with dnd5e 5.3.3 and libWrapper 1.13.5.1; the GM reported Chrome 152. The desktop application hosted the world at its join screen.

Two further playback defects were fixed before these runs:

- The stale-autoplay guard must use libWrapper `MIXED`. A `WRAPPER` hook that intentionally returns without invoking native playback can be automatically unregistered, causing subsequent starts to lose loop and skip-intro handling. A behavioral registration test now rejects a stale start and verifies that the next valid start retains those features.
- A delayed internal-loop start could skip the segment containing the already-playing position. Startup now adopts that segment through the existing position-aware scheduling path, preserving future intros and retiring only after applicable segments have ended.

Together with the silence cancellation, effective playback offset, delayed-autoplay, and playback-clock ordering fixes described above, these passed **112 Node regression tests**. All **57 JavaScript files** passed syntax validation. Private maintenance checks reported **0 failures and 5 existing warning groups**; `git diff --check` found no whitespace errors. An independent final runtime review found no further concrete defect in the changed lifecycle boundaries.

| Live browser coverage | Scenarios | Passed assertions | Failures | Inconclusive |
| --- | ---: | ---: | ---: | ---: |
| Full GM playback matrix listed above | 15 | 159 | 0 | 0 |
| Repeated natural playback with crossfade/silence disabled | 1 | 2 | 0 | 0 |
| GM/player synchronization | 16 | 154 | 0 | 0 |

The multiplayer matrix covered responder identity, authority election, basic playback, crossfade, Stop during transitions, cold rapid Play/Stop, silence completion/manual cancellation, loop break/disable/segment skip, soundscape start/stop, bed-only playback, procedural fire/arm/disarm, player opt-out, and cleanup. Rapid Play/Stop ran before the GM loop checks, confirming that stale-start rejection did not unregister the playback hook. Live-media assertions required the same preflight clients to respond and rejected unexpected extra media.

Postflight showed no fixture playlists, sounds, or folders; no active media, loopers, crossfades, silence gaps, soundscapes, or preload records; and the original 17 playlists, 393 sounds, 20 actors, 29 items, 3 journals, and 2 scenes. Temporarily changed shuffle, fade, and procedural-sync settings were restored, and both clients' personal audio mixes remained disabled. The captured rolling console buffer contained no warnings or errors at postflight; its 200-entry limit does not establish a complete-session log. GM audio-cache accounting matched retained buffers at 13,324,784 bytes, and its JavaScript heap used about 125 MB.

A diagnostics-only follow-up corrects world refresh to reload the requesting GM as well as broadcasting to other clients, following Foundry's native settings reload behavior. A direct probe verified sender/peer reload dispatch, client-only scope, and rejection without world-settings permission. The final matrix used separately verified refreshed clients.

These results establish the tested two-browser behavior, not a universal absence of bugs. Listening/visual checks, Firefox, third-party audio integrations, historical v13 support, packaging from the eventual tag, and clean installation remain outside this final matrix. Nothing has been committed, tagged, or published.

### Final Electron comparison: failure reproduced with current fixes

The user returned the GM to Electron 41.3.0 / Chromium 146.0.7680.188 while TestUser stayed in its browser. This freshly loaded GM now had unlocked **48 kHz** contexts, an empty audio buffer cache, and approximately 111.6 MB JavaScript heap. Thus 96 kHz audio and accumulated cache contents are not required for this reproduction.

The scoped `electron-final153-nativeReplay` run used two 1.2-second clips with crossfade and silence disabled. The MCP connection closed during the second natural replay. The user confirmed the same grey/black view and DevTools message: "DevTools was disconnected from the page." Foundry PID 21152 disappeared while the other five observed Foundry processes kept their original start times. This comparison did not show a full application/server restart.

After the user refreshed without unlocking audio, the durable marker was **`native-replay-2.natural-end:before`**. At that marker the source media was stopped (state 7), and the target media was playing (state 4) at approximately 0.301 seconds of its 1.2-second duration. This bounds the interrupted operation but does not identify a native crash cause. SoS wrappers remained loaded even though its two transition features were disabled.

Scoped cleanup removed exactly the one fixture playlist, its two sounds, and its folder. Counts returned to 17 playlists, 393 sounds, 27 folders, 20 actors, 29 items, 3 journals, and 2 scenes. Post-recovery read-only diagnostics passed **12 smoke assertions**, **10 settings checks**, and **16 asset checks**.

The read-only crash-record audit found no recent Windows Application crash/hang/WER event, WER diagnostic event, or matching Foundry/Electron dump/report in standard locations. Foundry's current error log was empty and its debug log predated the failure. No native exception, stack, or exit code was available from these records.

The Electron failure remains a release limitation. The same playback runtime completed the browser matrix, including this replay scenario, but that difference alone does not attribute the failure to Electron/Chromium, Foundry core, or a SoS interaction. Browser GM/player sessions are the validated configuration from this pass.
