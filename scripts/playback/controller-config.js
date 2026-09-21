import { normalizePlaybackControllerPolicy } from "../core-helpers.js";
import { MODULE_ID, PlaylistActionAuthority } from "../utils.js";

export function canConfigurePlaybackController() {
  return Number(game.user?.role) === 4 && game.user?.isGM === true;
}

export async function savePlaybackControllerPolicy(value) {
  if (!canConfigurePlaybackController()) throw new Error("Only a full Gamemaster may configure the playback controller.");
  const policy = normalizePlaybackControllerPolicy(value);
  if (policy.preferredUserId && policy.excludedUserIds.includes(policy.preferredUserId)) {
    throw new Error("The preferred playback controller cannot also be excluded.");
  }
  // Keep an unavailable saved preference until the GM explicitly replaces it.
  if (policy.preferredUserId && policy.preferredUserId !== PlaylistActionAuthority.getPolicy().preferredUserId) {
    const preferred = Array.from(game.users ?? []).find(user => String(user.id) === policy.preferredUserId);
    if (!preferred?.isGM || Number(preferred.role) < 3) throw new Error("Choose a Gamemaster or Assistant GM account.");
  }
  return game.settings.set(MODULE_ID, "playbackControllerPolicy", policy);
}

export class PlaybackControllerConfig extends foundry.applications.api.HandlebarsApplicationMixin(foundry.applications.api.ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "sos-playback-controller-config",
    tag: "form",
    window: { title: "Sound of Silence — Playback Controller" },
    position: { width: 480 },
    form: { handler: PlaybackControllerConfig.submitPolicy, closeOnSubmit: true },
  };

  static PARTS = { form: { template: `modules/${MODULE_ID}/templates/playback-controller.hbs` } };

  render(...args) {
    if (!canConfigurePlaybackController()) {
      ui.notifications?.error?.("Only a full Gamemaster may configure the playback controller.");
      return this;
    }
    return super.render(...args);
  }

  async _prepareContext() {
    if (!canConfigurePlaybackController()) throw new Error("Full Gamemaster access required.");
    const policy = PlaylistActionAuthority.getPolicy();
    const users = Array.from(game.users ?? []).filter(user => user.isGM);
    const accounts = users.map(user => ({
      id: String(user.id),
      label: `${user.name} (${Number(user.role) >= 4 ? "Gamemaster" : "Assistant GM"}${user.active ? "" : ", offline"})`,
    }));
    for (const id of [policy.preferredUserId, ...policy.excludedUserIds].filter(Boolean)) {
      if (accounts.some(account => account.id === id)) continue;
      const user = Array.from(game.users ?? []).find(user => String(user.id) === id);
      accounts.push({ id, label: `${user?.name ?? id} (unavailable)` });
    }
    accounts.sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
    return {
      automatic: !policy.preferredUserId,
      accounts: accounts.map(account => ({
        ...account,
        preferred: account.id === policy.preferredUserId,
        excluded: policy.excludedUserIds.includes(account.id),
      })),
    };
  }

  static async submitPolicy(_event, form) {
    // ApplicationV2 reports rejected submissions and keeps the form open.
    await savePlaybackControllerPolicy({
      preferredUserId: form.elements.preferredUserId.value || null,
      excludedUserIds: Array.from(form.querySelectorAll('input[name="excludedUserIds"]:checked'), input => input.value),
    });
  }
}
