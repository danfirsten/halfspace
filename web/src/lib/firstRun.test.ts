import { describe, expect, it } from 'vitest';
import { dismissHint, HINT_KEY, shouldShowHint } from './firstRun';

function fakeStore(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  };
}

describe('first-run hint state', () => {
  it('shows on a browser that has never seen it', () => {
    expect(shouldShowHint(fakeStore())).toBe(true);
  });

  it('stays hidden once dismissed', () => {
    const store = fakeStore();
    dismissHint(store);
    expect(store.map.get(HINT_KEY)).toBe('dismissed');
    expect(shouldShowHint(store)).toBe(false);
  });

  it('is idempotent — dismissing twice is dismissing once', () => {
    const store = fakeStore();
    dismissHint(store);
    dismissHint(store);
    expect(store.map.size).toBe(1);
    expect(shouldShowHint(store)).toBe(false);
  });

  it('treats any stored value as a dismissal, so an older key never revives it', () => {
    expect(shouldShowHint(fakeStore({ [HINT_KEY]: 'seen' }))).toBe(false);
  });

  it('stays hidden when there is no storage at all', () => {
    // Safari private mode, file:// origins, storage disabled: an unclosable
    // hint is worse than a missing one.
    expect(shouldShowHint(null)).toBe(false);
    expect(() => dismissHint(null)).not.toThrow();
  });

  it('stays hidden when storage throws on read', () => {
    const hostile = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('SecurityError');
      },
    };
    expect(shouldShowHint(hostile)).toBe(false);
    expect(() => dismissHint(hostile)).not.toThrow();
  });
});
