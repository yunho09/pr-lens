// "봤음" state, client-safe and pure. Stored per PR (not per head SHA) as a
// list of hunk anchor keys, so a hunk that only moved stays checked across
// pushes, while a changed hunk, or the same edit in another place, comes back
// unchecked. v3: keys are anchor keys (v2 held content fingerprints).

export function seenStorageKey(owner: string, repo: string, number: number): string {
  return `pr-lens:seen:v3:${owner}/${repo}/${number}`;
}

/** What 봤음 remembers for a hunk: its anchor key, or for a result cached before anchor keys, its fingerprint. */
export function seenKey(hunk: { anchorKey?: string; fingerprint: string }): string {
  return hunk.anchorKey ?? hunk.fingerprint;
}

/** Parses stored JSON; anything unexpected (old format, corrupt) yields an empty set. */
export function parseSeenKeys(raw: string | null): Set<string> {
  if (!raw) return new Set();
  try {
    const parsed: unknown = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : []);
  } catch {
    return new Set();
  }
}

/**
 * The seen set after a `storage` event from another tab, or null when the
 * event is about another key. A null key means the storage was cleared.
 */
export function seenFromStorageEvent(
  event: { key: string | null; newValue: string | null },
  storageKey: string,
): Set<string> | null {
  if (event.key !== null && event.key !== storageKey) return null;
  return parseSeenKeys(event.key === null ? null : event.newValue);
}

export function serializeSeenKeys(keys: Set<string>): string {
  return JSON.stringify([...keys]);
}

/** Hunk ids of the current analysis whose key was marked seen. */
export function seenHunkIds(
  keys: Set<string>,
  hunks: Array<{ id: string; anchorKey?: string; fingerprint: string }>,
): Set<string> {
  return new Set(hunks.filter((h) => keys.has(seenKey(h))).map((h) => h.id));
}

export function toggleSeenKey(keys: Set<string>, key: string): Set<string> {
  const next = new Set(keys);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}
