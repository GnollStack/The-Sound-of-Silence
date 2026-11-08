/**
 * Activate and render Foundry's Playlists sidebar before audio diagnostics.
 * Dependency injection keeps this boundary testable outside a Foundry client.
 */
export async function activatePlaylistSidebar({
  sidebar = globalThis.ui?.sidebar ?? null,
  playlistDirectory = globalThis.ui?.playlists ?? null,
  settleMs = 100,
  sleep = defaultSleep,
} = {}) {
  const previousTab = getActiveSidebarTab(sidebar);
  const result = {
    success: false,
    requestedTab: "playlists",
    previousTab,
    activeTab: previousTab,
    activationMethod: null,
    sidebarRenderedByAutomation: false,
    directoryRenderRequested: false,
    directoryRendered: Boolean(playlistDirectory?.rendered),
    error: null,
  };

  if (!sidebar) {
    result.error = "Foundry sidebar is unavailable.";
    return result;
  }

  try {
    if (sidebar.rendered === false && typeof sidebar.render === "function") {
      await sidebar.render({ force: true });
      result.sidebarRenderedByAutomation = true;
    }

    if (typeof sidebar.changeTab !== "function") {
      throw new Error("Foundry sidebar does not expose changeTab.");
    }
    await sidebar.changeTab("playlists", "primary", { force: true });
    result.activationMethod = "changeTab";

    if (typeof playlistDirectory?.render === "function") {
      await playlistDirectory.render({ force: true });
      result.directoryRenderRequested = true;
    }
    if (settleMs > 0) await sleep(settleMs);

    result.activeTab = getActiveSidebarTab(sidebar);
    result.directoryRendered = Boolean(playlistDirectory?.rendered);
    result.success = result.activeTab === "playlists";
    if (!result.success) {
      result.error = "Foundry did not make the Playlists sidebar active.";
    }
  } catch (err) {
    result.activeTab = getActiveSidebarTab(sidebar);
    result.directoryRendered = Boolean(playlistDirectory?.rendered);
    result.error = err instanceof Error ? err.message : String(err);
  }

  return result;
}

function getActiveSidebarTab(sidebar) {
  const value = sidebar?.tabGroups?.primary ?? null;
  return typeof value === "string" && value ? value : null;
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
