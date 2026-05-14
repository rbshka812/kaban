// POST /api/inventory-batch
// Body: { steamids: ["76561...", ...] }
// Returns: { results: { "76561...": { is_private, total_usd, items_count } }, total_usd }
//
// Called by Tampermonkey userscript running on cybershoke.net.
// CORS allows cybershoke.net + localhost for development.

import { fetchInventory } from './_lib/steam.js';
import { getPriceMap, sumItems } from './_lib/prices.js';

const ALLOWED_ORIGINS = new Set([
  'https://cybershoke.net',
  'http://localhost:3000',
  'https://localhost:3000',
]);

function applyCors(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

export default async function handler(req, res) {
  applyCors(req, res);

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  // Vercel auto-parses JSON if Content-Type: application/json
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  const raw = Array.isArray(body.steamids) ? body.steamids : [];
  // Filter + dedupe + validate
  const seen = new Set();
  const steamids = [];
  for (const s of raw) {
    const str = String(s).trim();
    if (/^\d{17}$/.test(str) && !seen.has(str)) {
      seen.add(str);
      steamids.push(str);
    }
    if (steamids.length >= 64) break; // hard cap, server usually <= 32
  }

  if (steamids.length === 0) {
    return res.status(400).json({ error: 'no_steamids', message: 'Expected { steamids: ["7656..."] }' });
  }

  try {
    // Load prices once for the whole batch
    const priceMap = await getPriceMap();

    // Fetch inventories in parallel with concurrency cap (Steam rate-limits hard)
    const CONCURRENCY = 4;
    const results = {};
    let totalUsd = 0;
    let privateCount = 0;
    let errorCount = 0;

    let idx = 0;
    async function worker() {
      while (idx < steamids.length) {
        const myIdx = idx++;
        const sid = steamids[myIdx];
        try {
          const inv = await fetchInventory(sid);
          if (inv.is_private) {
            results[sid] = { is_private: true };
            privateCount++;
            continue;
          }
          if (inv.error) {
            results[sid] = { error: inv.error };
            errorCount++;
            continue;
          }
          const { total_usd, counted, missing } = sumItems(inv.items, priceMap);
          results[sid] = {
            is_private: false,
            total_usd,
            items_count: inv.items_count,
            priced_items: counted,
            unpriced_items: missing,
          };
          totalUsd += total_usd;
        } catch (e) {
          results[sid] = { error: 'failed', message: e.message };
          errorCount++;
        }
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=900');
    res.status(200).json({
      results,
      total_usd: Math.round(totalUsd * 100) / 100,
      stats: {
        requested: steamids.length,
        private: privateCount,
        errors: errorCount,
        public: steamids.length - privateCount - errorCount,
      },
    });
  } catch (e) {
    res.status(502).json({ error: 'failed', message: e.message });
  }
}
