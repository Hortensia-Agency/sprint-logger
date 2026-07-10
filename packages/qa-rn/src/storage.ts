/**
 * Per-device persistence over AsyncStorage. Two things survive app restarts:
 *   - the pasted mobile_widget PAT (so the tester pastes once per device)
 *   - the movable FAB position (so it stays where the tester dragged it)
 *
 * AsyncStorage is a peer dep so the host's single instance is shared. If it's
 * absent (misconfigured host) the calls degrade to in-memory for the session.
 */

type AsyncStorageLike = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
};

let store: AsyncStorageLike;
try {
  // Lazy require so a host without AsyncStorage still loads the module.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  store = require("@react-native-async-storage/async-storage").default;
} catch {
  const mem = new Map<string, string>();
  store = {
    async getItem(k) {
      return mem.has(k) ? (mem.get(k) as string) : null;
    },
    async setItem(k, v) {
      mem.set(k, v);
    },
    async removeItem(k) {
      mem.delete(k);
    },
  };
}

const PAT_KEY = "sprint-qa-pat";
const FAB_POS_KEY = "sprint-qa-fab-pos";
const DEVICE_ID_KEY = "sprint-qa-device-id";

/**
 * A stable per-device id, generated once and persisted. Used to name per-device
 * PATs so signing in on one device never revokes another's token.
 */
export async function getDeviceId(): Promise<string> {
  const existing = await store.getItem(DEVICE_ID_KEY);
  if (existing) return existing;
  const id =
    "dev_" +
    Math.random().toString(36).slice(2) +
    Date.now().toString(36);
  await store.setItem(DEVICE_ID_KEY, id);
  return id;
}

export async function loadPat(): Promise<string | null> {
  return store.getItem(PAT_KEY);
}
export async function savePat(pat: string): Promise<void> {
  return store.setItem(PAT_KEY, pat);
}
export async function clearPat(): Promise<void> {
  return store.removeItem(PAT_KEY);
}

export interface FabPos {
  x: number;
  y: number;
}
export async function loadFabPos(): Promise<FabPos | null> {
  const raw = await store.getItem(FAB_POS_KEY);
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as FabPos;
    if (typeof p.x === "number" && typeof p.y === "number") return p;
  } catch {
    /* ignore corrupt value */
  }
  return null;
}
export async function saveFabPos(pos: FabPos): Promise<void> {
  return store.setItem(FAB_POS_KEY, JSON.stringify(pos));
}
