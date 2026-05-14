// Steam inventory fetcher (public endpoint, no API key).
//
// Endpoint: GET https://steamcommunity.com/inventory/{steamid64}/730/2?l=english&count=5000
// Response shapes:
//   - 200 with { success: true, assets, descriptions } → public inventory
//   - 200 with { success: false } OR 401/403 → private/closed inventory
//   - 429 → rate limited (back off + retry)

import { memoize } from './cache.js';

const STEAM_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

async function fetchInventoryImpl(steamid64) {
  if (!/^\d{17}$/.test(steamid64)) {
    return { is_private: true, error: 'invalid_steamid' };
  }

  const url = `https://steamcommunity.com/inventory/${steamid64}/730/2?l=english&count=5000`;
  let r;
  try {
    r = await fetch(url, {
      headers: {
        'User-Agent': STEAM_UA,
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://steamcommunity.com/',
      },
    });
  } catch (e) {
    return { is_private: false, error: 'network', message: e.message, items: [] };
  }

  if (r.status === 401 || r.status === 403) return { is_private: true, items: [] };
  if (r.status === 429) return { is_private: false, error: 'rate_limited', items: [] };
  if (!r.ok) return { is_private: false, error: `http_${r.status}`, items: [] };

  let json;
  try {
    json = await r.json();
  } catch {
    return { is_private: false, error: 'parse_failed', items: [] };
  }

  if (!json || json.success === false) return { is_private: true, items: [] };
  if (!Array.isArray(json.descriptions)) return { is_private: false, items: [] };

  // Build map: classid_instanceid -> description (for asset → description lookup)
  // We only need market_hash_name per asset to look up price.
  const descByKey = new Map();
  for (const d of json.descriptions) {
    if (d?.market_hash_name) {
      descByKey.set(`${d.classid}_${d.instanceid}`, d.market_hash_name);
    }
  }

  // Walk assets list to collect market_hash_names (with duplicates for stacks)
  const items = [];
  for (const a of json.assets || []) {
    const name = descByKey.get(`${a.classid}_${a.instanceid}`);
    if (name) items.push(name);
  }

  return {
    is_private: false,
    items,
    items_count: items.length,
  };
}

// Cache 1h per SteamID — inventories don't change every minute, and Steam rate-limits hard
export const fetchInventory = memoize(fetchInventoryImpl, { ttlMs: 3600_000, keyPrefix: 'inv:' });
