/**
 * Crash persistence (0.2.0). The reason a JS-only reporter loses hard crashes
 * is ordering: `post()` is async, so a crash that tears down the runtime kills
 * the in-flight fetch and the report dies with it. Sentry survives this by
 * writing the crash to disk natively and uploading on the NEXT launch.
 *
 * This is the pure-JS approximation of that: before attempting delivery of an
 * UNCAUGHT error we synchronously hand the payload to AsyncStorage, then try to
 * send. On success the pending entry is dropped; if the process dies first the
 * entry survives and `flushPending()` ships it at the next init().
 *
 * The honest limit: AsyncStorage.setItem is itself async (it hops to the native
 * module). A crash that kills the VM in the same tick can still outrun it. This
 * closes the common case (fatal JS error → RedBox/abort a few ticks later), not
 * the instant-native-abort case — that needs the native module (see PLAN).
 */

import AsyncStorage from "@react-native-async-storage/async-storage";

const PENDING_KEY = "@sprint_signals_pending";
const MAX_PENDING = 20;
// A payload older than this is stale (the app may have been offline for days);
// still worth sending, but we bound the queue so storage never grows unbounded.
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface PendingEntry {
  /** Client-generated id so a double-flush can be de-duplicated server-side. */
  id: string;
  body: Record<string, unknown>;
  savedAt: number;
}

function safeParse(raw: string | null): PendingEntry[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as PendingEntry[]) : [];
  } catch {
    return [];
  }
}

/** Queue a payload for next-launch delivery. Never throws. */
export async function savePending(id: string, body: Record<string, unknown>): Promise<void> {
  try {
    const list = safeParse(await AsyncStorage.getItem(PENDING_KEY));
    list.push({ id, body, savedAt: Date.now() });
    // Keep the most recent; an app crash-looping must not fill storage.
    const trimmed = list.slice(-MAX_PENDING);
    await AsyncStorage.setItem(PENDING_KEY, JSON.stringify(trimmed));
  } catch {
    /* storage unavailable — delivery falls back to the live attempt only */
  }
}

/** Drop one entry after it was delivered (or proved undeliverable). */
export async function clearPending(id: string): Promise<void> {
  try {
    const list = safeParse(await AsyncStorage.getItem(PENDING_KEY));
    const next = list.filter((e) => e.id !== id);
    if (next.length === list.length) return;
    await AsyncStorage.setItem(PENDING_KEY, JSON.stringify(next));
  } catch {
    /* swallow */
  }
}

/**
 * Read and clear the whole queue. Returns entries young enough to be worth
 * sending; expired ones are discarded silently. Read-then-clear (rather than
 * clear-per-success) keeps a flush from re-sending on a slow network.
 */
export async function takePending(): Promise<PendingEntry[]> {
  try {
    const list = safeParse(await AsyncStorage.getItem(PENDING_KEY));
    if (!list.length) return [];
    await AsyncStorage.removeItem(PENDING_KEY);
    const cutoff = Date.now() - MAX_AGE_MS;
    return list.filter((e) => typeof e?.savedAt === "number" && e.savedAt >= cutoff && e.body);
  } catch {
    return [];
  }
}
