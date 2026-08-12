/**
 * Storage shim.
 *
 * Inside the Claude artifact sandbox, `window.storage` is provided by the
 * host. Everywhere else it does not exist, which would leave the app running
 * but silently never saving.
 *
 * This installs a localStorage-backed implementation with the same async
 * interface, but only when the host has not already provided one. That keeps
 * a single copy of Ledger.jsx working in both environments with no changes to
 * the component itself.
 */

const NAMESPACE = "ledger:";

function scoped(key) {
  return key.startsWith(NAMESPACE) ? key : NAMESPACE + key;
}

const shim = {
  async get(key) {
    const value = localStorage.getItem(scoped(key));
    if (value === null) throw new Error(`No stored value for "${key}"`);
    return { key, value, shared: false };
  },

  async set(key, value) {
    try {
      localStorage.setItem(scoped(key), value);
    } catch (err) {
      // QuotaExceededError, or Safari private mode. Surface it so the app
      // can flip into its read-only warning state instead of pretending
      // the write landed.
      throw new Error(`Could not save "${key}": ${err.message}`);
    }
    return { key, value, shared: false };
  },

  async delete(key) {
    localStorage.removeItem(scoped(key));
    return { key, deleted: true, shared: false };
  },

  async list(prefix = "") {
    const want = scoped(prefix);
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(want)) keys.push(k.slice(NAMESPACE.length));
    }
    return { keys, prefix, shared: false };
  },
};

export function installStorage() {
  if (typeof window === "undefined") return;
  if (window.storage) return; // artifact host already supplies it
  try {
    // Probe first: private browsing can expose localStorage but reject writes.
    const probe = "__ledger_probe__";
    localStorage.setItem(probe, "1");
    localStorage.removeItem(probe);
    window.storage = shim;
  } catch (err) {
    // Leave window.storage undefined. The app already handles that and shows
    // its "saving is unavailable" banner.
    console.warn("Ledger: local storage unavailable, running without saving.");
  }
}
