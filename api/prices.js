// GET /api/prices
// Returns Skinport price map as { prices: { "market_hash_name": price_usd, ... } }
// Used as fallback by userscript when client-side Skinport call fails (VPN, regional block).

import { getPriceMap } from './_lib/prices.js';

const ALLOWED_ORIGINS = new Set([
  'https://cybershoke.net',
  'http://localhost:3000',
  'https://localhost:3000',
]);

export default async function handler(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });

  try {
    const map = await getPriceMap();
    const prices = Object.fromEntries(map);
    res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=7200');
    res.status(200).json({ prices, count: map.size });
  } catch (e) {
    res.status(502).json({ error: 'failed', message: e.message });
  }
}
