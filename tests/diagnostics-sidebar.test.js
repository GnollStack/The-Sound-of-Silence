import test from "node:test";
import assert from "node:assert/strict";

import { activatePlaylistSidebar } from "../scripts/diagnostics-sidebar.js";

const noWait = async () => {};

test("playlist diagnostics activate and render the v14 sidebar tab", async () => {
  const calls = [];
  const sidebar = {
    rendered: true,
    tabGroups: { primary: "chat" },
    changeTab(tab, group, options) {
      calls.push({ tab, group, options });
      this.tabGroups[group] = tab;
    },
  };
  const playlistDirectory = {
    rendered: false,
    async render(options) {
      calls.push({ render: options });
      this.rendered = true;
    },
  };

  const result = await activatePlaylistSidebar({ sidebar, playlistDirectory, settleMs: 0, sleep: noWait });

  assert.equal(result.success, true);
  assert.equal(result.previousTab, "chat");
  assert.equal(result.activeTab, "playlists");
  assert.equal(result.activationMethod, "changeTab");
  assert.equal(result.directoryRenderRequested, true);
  assert.deepEqual(calls[0], { tab: "playlists", group: "primary", options: { force: true } });
});

test("playlist diagnostics fall back to the v13 activateTab API", async () => {
  const sidebar = {
    activeTab: "chat",
    activateTab(tab) {
      this.activeTab = tab;
    },
  };

  const result = await activatePlaylistSidebar({ sidebar, playlistDirectory: null, settleMs: 0, sleep: noWait });

  assert.equal(result.success, true);
  assert.equal(result.activationMethod, "activateTab");
  assert.equal(result.activeTab, "playlists");
});

test("playlist diagnostics render an uninitialized sidebar before activation", async () => {
  const sidebar = {
    rendered: false,
    tabGroups: { primary: "chat" },
    async render(options) {
      assert.deepEqual(options, { force: true });
      this.rendered = true;
    },
    changeTab(tab, group) {
      this.tabGroups[group] = tab;
    },
  };

  const result = await activatePlaylistSidebar({ sidebar, playlistDirectory: null, settleMs: 0, sleep: noWait });

  assert.equal(result.success, true);
  assert.equal(result.sidebarRenderedByAutomation, true);
});

test("playlist diagnostics return an explicit failure when the sidebar is unavailable", async () => {
  const result = await activatePlaylistSidebar({ sidebar: null, playlistDirectory: null, settleMs: 0, sleep: noWait });

  assert.equal(result.success, false);
  assert.match(result.error, /sidebar is unavailable/i);
});
