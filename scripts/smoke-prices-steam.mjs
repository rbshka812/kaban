// Smoke test: prices + steam library modules.
// Run with: node scripts/smoke-prices-steam.mjs
import { getPriceMap, sumItems } from '../api/_lib/prices.js';
import { fetchInventory } from '../api/_lib/steam.js';

console.log('=== Skinport: loading price map ===');
const t0 = Date.now();
const map = await getPriceMap();
console.log(`loaded ${map.size} prices in ${Date.now() - t0}ms`);

const samples = [
  'AK-47 | Redline (Field-Tested)',
  'AWP | Asiimov (Field-Tested)',
  'M4A4 | Howl (Factory New)',
  'Glock-18 | Water Elemental (Minimal Wear)',
  'USP-S | Kill Confirmed (Field-Tested)',
];
for (const name of samples) {
  console.log(`  ${name}: $${map.get(name) ?? 'NOT FOUND'}`);
}

console.log('');
console.log('=== Steam inventory ===');
// GabeN — known SteamID, used for testing
const steamids = [
  '76561197960287930',          // GabeN
  '76561198013214328',          // random
];
for (const sid of steamids) {
  console.log(`\nSteamID: ${sid}`);
  const inv = await fetchInventory(sid);
  if (inv.is_private) {
    console.log('  → private/closed inventory');
  } else if (inv.error) {
    console.log(`  → error: ${inv.error}`);
  } else {
    console.log(`  → ${inv.items_count} items`);
    const summed = sumItems(inv.items, map);
    console.log(`  → total: $${summed.total_usd} (priced: ${summed.counted}, unpriced: ${summed.missing})`);
    console.log(`  → first 3 items: ${inv.items.slice(0, 3).join(', ')}`);
  }
}

console.log('\n=== done ===');
