// In-memory TTL cache for serverless functions.
// Persists between invocations on the same warm instance (Vercel reuses).

const store = new Map();

export function getCached(key) {
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return null;
  }
  return entry.value;
}

export function setCached(key, value, ttlMs) {
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
}

// Memoize an async function with a key derived from its arguments.
export function memoize(fn, { ttlMs, keyPrefix = '' }) {
  return async (...args) => {
    const key = keyPrefix + JSON.stringify(args);
    const cached = getCached(key);
    if (cached !== null) return cached;
    const value = await fn(...args);
    setCached(key, value, ttlMs);
    return value;
  };
}
