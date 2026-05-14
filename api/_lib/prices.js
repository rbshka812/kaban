// Skinport price loader.
//
// Endpoint: GET https://api.skinport.com/v1/items?app_id=730&currency=USD&tradable=0
// Response: array of { market_hash_name, suggested_price, min_price, mean_price, ... }
// Size: ~600KB brotli-compressed, ~20-25k items
// We pick `suggested_price` as primary, fall back to `mean_price`.

import { getCached, setCached } from './cache.js';

const PRICES_KEY = 'skinport_prices';
const PRICES_TTL_MS = 3600_000; // 1h

async function loadFromSkinport() {
  const r = await fetch('https://api.skinport.com/v1/items?app_id=730&currency=USD&tradable=0', {
    headers: {
      'Accept-Encoding': 'br',
      'Accept': 'application/json',
      'User-Agent': 'cybershoke-live/0.1',
    },
  });
  if (!r.ok) throw new Error(`Skinport ${r.status}`);
  const arr = await r.json();
  const map = new Map();
  for (const item of arr) {
    if (!item?.market_hash_name) continue;
    const price = item.suggested_price ?? item.mean_price ?? item.min_price;
    if (typeof price === 'number') map.set(item.market_hash_name, price);
  }
  return map;
}

let inflight = null;

/** Returns a Map<market_hash_name, price_usd>. Lazy-loads + caches 1h. */
export async function getPriceMap() {
  const cached = getCached(PRICES_KEY);
  if (cached) return cached;
  // Avoid thundering herd on cold-cache concurrent calls
  if (inflight) return inflight;
  inflight = loadFromSkinport()
    .then((map) => {
      setCached(PRICES_KEY, map, PRICES_TTL_MS);
      return map;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** Sum prices for a list of market_hash_name (with possible duplicates). */
export function sumItems(items, priceMap) {
  let total = 0;
  let counted = 0;
  let missing = 0;
  for (const name of items) {
    const p = priceMap.get(name);
    if (typeof p === 'number') {
      total += p;
      counted++;
    } else {
      missing++;
    }
  }
  return { total_usd: Math.round(total * 100) / 100, counted, missing };
}
