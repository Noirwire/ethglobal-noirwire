const cache = new Map<string, { at: number; value: Promise<unknown> }>();

export function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as Promise<T>;
  const value = load();
  const entry = { at: Date.now(), value };
  cache.set(key, entry);
  value.catch(() => {
    if (cache.get(key) === entry) cache.delete(key);
  });
  return value;
}

export function resetCache(): void {
  cache.clear();
}
