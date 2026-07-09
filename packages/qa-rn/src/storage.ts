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
