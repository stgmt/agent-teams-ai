const STORAGE_PREFIX = 'team-chat-focus:';
const EMPTY_KEYS: readonly string[] = Object.freeze([]);
const listeners = new Set<() => void>();
let snapshotVersion = 0;
const snapshotCache = new Map<string, { version: number; keys: readonly string[] }>();
const volatileFallback = new Map<string, readonly string[]>();

function storageKey(teamName: string): string {
  return `${STORAGE_PREFIX}${teamName}`;
}

function normalizeKeys(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const keys = value.filter((key): key is string => typeof key === 'string' && key.length > 0);
  return [...new Set(keys)];
}

function notifyFocusedChats(): void {
  snapshotVersion += 1;
  snapshotCache.clear();
  for (const listener of listeners) {
    listener();
  }
}

export function subscribeFocusedChats(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Conversation scope keys with focus mode on, per team. */
export function loadFocusedChatKeys(teamName: string): string[] {
  if (!teamName) return [];
  const fallback = volatileFallback.get(teamName);
  if (fallback) return [...fallback];
  try {
    const raw = localStorage.getItem(storageKey(teamName));
    return raw ? normalizeKeys(JSON.parse(raw) as unknown) : [];
  } catch {
    return [];
  }
}

export function getFocusedChatKeysSnapshot(teamName: string): readonly string[] {
  if (!teamName) return EMPTY_KEYS;
  const cached = snapshotCache.get(teamName);
  if (cached && cached.version === snapshotVersion) return cached.keys;
  const loaded = loadFocusedChatKeys(teamName);
  const keys = loaded.length === 0 ? EMPTY_KEYS : Object.freeze(loaded);
  snapshotCache.set(teamName, { version: snapshotVersion, keys });
  return keys;
}

export function setChatFocused(teamName: string, scopeKey: string, focused: boolean): void {
  if (!teamName || !scopeKey) return;
  const current = loadFocusedChatKeys(teamName).filter((key) => key !== scopeKey);
  const next = Object.freeze(focused ? [...current, scopeKey] : current);
  try {
    if (next.length === 0) {
      localStorage.removeItem(storageKey(teamName));
    } else {
      localStorage.setItem(storageKey(teamName), JSON.stringify(next));
    }
    volatileFallback.delete(teamName);
  } catch {
    volatileFallback.set(teamName, next);
  }
  notifyFocusedChats();
}
