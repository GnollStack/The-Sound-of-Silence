/**
 * @file main.js
 * @description Runtime entrypoint. Feature hooks and wrappers are registered by bootstrap/lifecycle.js.
 */
import { registerLifecycleHooks } from "./bootstrap/lifecycle.js";

export { cancelSilentGap } from "./playlist/playlist-actions.js";

registerLifecycleHooks();
