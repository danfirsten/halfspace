/**
 * The one-time first-run hint.
 *
 * It teaches the demo path — run a preset, open a phase, ask for more like it —
 * and then gets out of the way permanently. Three rules govern it:
 *
 *   1. It is read synchronously, so it is present in the very first render and
 *      never pushes the grid down after paint.
 *   2. It is in the document flow. It covers nothing, traps nothing, and a
 *      reviewer who ignores it can use every control on the page.
 *   3. Once it is gone it is gone: dismissing by hand and finishing the path
 *      both write the same key, and nothing ever clears it.
 *
 * `localStorage` can throw (Safari private mode, a file:// origin, a browser
 * with storage disabled). Every access here is guarded, and a browser that
 * cannot remember the dismissal is treated as one that has already seen it —
 * an unclosable hint is worse than a missing one.
 */

export const HINT_KEY = 'halfspace.hint.v1';

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>;

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** True when the hint has never been dismissed and can be stored if it is. */
export function shouldShowHint(store: Storage | null = storage()): boolean {
  if (!store) return false;
  try {
    return store.getItem(HINT_KEY) === null;
  } catch {
    return false;
  }
}

/** Records the dismissal. Safe to call repeatedly. */
export function dismissHint(store: Storage | null = storage()): void {
  if (!store) return;
  try {
    store.setItem(HINT_KEY, 'dismissed');
  } catch {
    /* a browser that will not remember simply shows it once per session */
  }
}
