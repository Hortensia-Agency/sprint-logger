/**
 * Whether the person hid the bubble on this device. They hide it by dragging
 * it onto the Hide target; the host's settings switch reads and sets the same
 * value, so turning it back on there shows the bubble at once.
 */

import { useEffect, useState } from "react";
import { loadHidden, saveHidden } from "./storage";

let current: boolean | null = null;
let loading: Promise<boolean> | null = null;
const listeners = new Set<(hidden: boolean) => void>();

/** Read the stored choice. False until the person hides the bubble. */
export function getSprintQaHidden(): Promise<boolean> {
  if (current !== null) return Promise.resolve(current);
  if (!loading) {
    loading = loadHidden().then((stored) => {
      if (current === null) current = stored;
      return current;
    });
  }
  return loading;
}

/** Hide or show the bubble on this device, and remember it across launches. */
export async function setSprintQaHidden(hidden: boolean): Promise<void> {
  current = hidden;
  listeners.forEach((l) => l(hidden));
  await saveHidden(hidden);
}

/** The stored choice, kept current; null until it has loaded. */
export function useSprintQaHidden(): boolean | null {
  const [hidden, setHidden] = useState<boolean | null>(current);
  useEffect(() => {
    let alive = true;
    listeners.add(setHidden);
    void getSprintQaHidden().then((v) => {
      if (alive) setHidden(v);
    });
    return () => {
      alive = false;
      listeners.delete(setHidden);
    };
  }, []);
  return hidden;
}
