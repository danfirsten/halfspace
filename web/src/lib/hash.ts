/**
 * The URL fragment, as a tiny parameter bag.
 *
 * There is no router. Deep links were one key (`#phase=…`) and are now two —
 * a report page can have a phase open on top of it, and closing the player has
 * to leave the report where it was. So the fragment is read and written as
 * `&`-joined `key=value` pairs, which is what the original `#phase=([^&]+)`
 * regex was already anticipating.
 *
 * Values keep `:` literal so a share link reads `#report=z:…` rather than
 * `#report=z%3A…`; `:` is a legal fragment character (RFC 3986 pchar).
 */

const encodeValue = (value: string) => encodeURIComponent(value).replace(/%3A/gi, ':');

export function readHashParam(hash: string, key: string): string | null {
  const body = hash.startsWith('#') ? hash.slice(1) : hash;
  for (const part of body.split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const name = eq < 0 ? part : part.slice(0, eq);
    if (name !== key) continue;
    const raw = eq < 0 ? '' : part.slice(eq + 1);
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw; // a damaged escape is still better shown than thrown
    }
  }
  return null;
}

/** Set or clear one key, leaving every other key and its order untouched. */
export function writeHashParam(hash: string, key: string, value: string | null): string {
  const body = hash.startsWith('#') ? hash.slice(1) : hash;
  const parts = body.split('&').filter(Boolean);
  const next: string[] = [];
  let replaced = false;
  for (const part of parts) {
    const eq = part.indexOf('=');
    const name = eq < 0 ? part : part.slice(0, eq);
    if (name !== key) {
      next.push(part);
      continue;
    }
    if (value !== null && !replaced) {
      next.push(`${key}=${encodeValue(value)}`);
      replaced = true;
    }
  }
  if (value !== null && !replaced) next.push(`${key}=${encodeValue(value)}`);
  return next.length ? `#${next.join('&')}` : '';
}
