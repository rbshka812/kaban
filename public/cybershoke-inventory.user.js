// ==UserScript==
// @name         Cybershoke Inventory Live
// @namespace    https://github.com/cybershoke-live
// @version      0.5.1
// @description  Показывает цены Steam-инвентарей всех игроков на сервере Cybershoke и общую сумму
// @author       you
// @match        https://cybershoke.net/*
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      steamcommunity.com
// @connect      api.skinport.com
// @connect      kaban-dun.vercel.app
// @connect      localhost
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  // === CONFIG ===
  // Skinport prices: memory only. Inventories: IndexedDB (see below).
  // Backend used as a fallback when client-side Skinport call fails (VPN/blocked IP).
  const BACKEND_URL = localStorage.getItem('csli_backend') || 'https://kaban-dun.vercel.app';
  const INV_TTL_MS       = 60 * 60 * 1000; // 1h
  const STEAM_CONCURRENCY = 3;

  const log = (...a) => console.log('%c[csli]', 'color:#ff5722;font-weight:bold', ...a);

  // === IndexedDB inventory cache ===
  // Why IDB and not localStorage: inventories accumulate to >5MB which trips quota.
  // IDB has 50%+ disk quota (usually GBs) and is also async — fits our codebase.
  const IDB_NAME = 'csli';
  const IDB_STORE = 'inv';
  let _idbPromise = null;
  function openIDB() {
    if (_idbPromise) return _idbPromise;
    _idbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          db.createObjectStore(IDB_STORE, { keyPath: 'sid' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror  = () => reject(req.error);
    }).catch(e => { _idbPromise = null; throw e; });
    return _idbPromise;
  }
  async function idbGetInv(sid) {
    try {
      const db = await openIDB();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readonly');
        const req = tx.objectStore(IDB_STORE).get(sid);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror  = () => reject(req.error);
      });
    } catch { return null; }
  }
  async function idbSetInv(sid, value) {
    try {
      const db = await openIDB();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).put({ sid, value, t: Date.now() });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (e) {
      log('IDB write failed:', e?.message || e);
    }
  }
  async function idbClearAll() {
    try {
      const db = await openIDB();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (e) {
      log('IDB clear failed:', e?.message || e);
    }
  }

  // Sweep stale localStorage inventory keys from v0.4.x (frees ~1-3 MB)
  (function migrateOldCache() {
    let n = 0;
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith('csli_inv_v1_') || k === 'csli_prices_v1') {
        localStorage.removeItem(k);
        n++;
      }
    }
    if (n > 0) log('Migrated to IndexedDB — cleared ' + n + ' legacy localStorage entries');
  })();

  // Expose cache-clear helper to DevTools (clears IDB + any leftover localStorage csli_* keys)
  const clearCache = async () => {
    await idbClearAll();
    let n = 0;
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith('csli_') && k !== 'csli_backend') { localStorage.removeItem(k); n++; }
    }
    log('Cleared IndexedDB inventory cache' + (n ? ' + ' + n + ' localStorage entries' : '') + '. Reload to refetch.');
  };
  try { unsafeWindow.csliClearCache = clearCache; } catch {}
  window.csliClearCache = clearCache;

  // === GM_xmlhttpRequest promisified (bypasses CORS + uses user's home IP) ===
  function gmFetchJSON(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        timeout: 30000,
        onload: (r) => {
          if (r.status >= 200 && r.status < 300) {
            try { resolve(JSON.parse(r.responseText)); }
            catch (e) { reject(new Error('Bad JSON: ' + e.message)); }
          } else {
            const err = new Error('HTTP ' + r.status);
            err.status = r.status;
            reject(err);
          }
        },
        onerror: () => reject(new Error('Network error: ' + url)),
        ontimeout: () => reject(new Error('Timeout: ' + url)),
      });
    });
  }

  // === Skinport prices ===
  let priceMap = null;
  let priceMapLoading = null;
  async function getPriceMap() {
    if (priceMap) return priceMap;
    if (priceMapLoading) return priceMapLoading;
    priceMapLoading = (async () => {
      const t0 = Date.now();
      let m;
      try {
        log('Fetching prices from Skinport (direct)…');
        const arr = await gmFetchJSON('https://api.skinport.com/v1/items?app_id=730&currency=USD&tradable=0');
        m = new Map();
        for (const item of arr) {
          const price = item.suggested_price ?? item.mean_price ?? item.min_price;
          if (item.market_hash_name && typeof price === 'number') {
            m.set(item.market_hash_name, price);
          }
        }
        log('Loaded ' + m.size + ' prices from Skinport in ' + (Date.now() - t0) + 'ms');
      } catch (e) {
        log('Skinport direct failed (' + e.message + ') — falling back to backend ' + BACKEND_URL);
        const obj = await gmFetchJSON(BACKEND_URL + '/api/prices');
        m = new Map();
        const prices = obj.prices || {};
        for (const name of Object.keys(prices)) {
          const p = prices[name];
          if (typeof p === 'number') m.set(name, p);
        }
        log('Loaded ' + m.size + ' prices from backend in ' + (Date.now() - t0) + 'ms');
      }
      // Skinport map (~636KB) too large for localStorage when combined with inventories.
      // Keep in memory only — refetched per session.
      priceMap = m;
      priceMapLoading = null;
      return m;
    })().catch((e) => {
      priceMapLoading = null;
      throw e;
    });
    return priceMapLoading;
  }

  // === Sleep helper ===
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // === Steam inventory fetch ===
  // Retry policy:
  //   429 (rate-limited): up to 3 attempts, exponential backoff (2s → 4s → 8s)
  //   403 (often transient IP block): 1 retry after 1.5s, then mark private
  //   other (400/5xx/network): no retry, return error
  async function fetchSteamInventory(steamid64) {
    const cached = await idbGetInv(steamid64);
    if (cached && (Date.now() - cached.t) < INV_TTL_MS) return cached.value;

    // Steam: count=5000 gives HTTP 400 for anonymous; 2000 works in 2026.
    const url = 'https://steamcommunity.com/inventory/' + steamid64 + '/730/2?l=english&count=2000';

    let json;
    let attempt = 0;
    const MAX_429 = 3;
    let tried403 = false;
    while (true) {
      attempt++;
      try {
        json = await gmFetchJSON(url);
        break;
      } catch (e) {
        if (e.status === 401) {
          const r = { is_private: true };
          await idbSetInv(steamid64, r);
          return r;
        }
        if (e.status === 429 && attempt < MAX_429) {
          const wait = 1000 * Math.pow(2, attempt); // 2s, 4s, 8s
          log('[steam ' + steamid64 + '] 429 retry ' + attempt + '/' + MAX_429 + ' in ' + wait + 'ms');
          await sleep(wait);
          continue;
        }
        if (e.status === 403 && !tried403) {
          tried403 = true;
          log('[steam ' + steamid64 + '] 403 retry in 1500ms');
          await sleep(1500);
          continue;
        }
        log('[steam ' + steamid64 + '] http error', e.status || '?', e.message);
        if (e.status === 403) {
          const r = { is_private: true };
          await idbSetInv(steamid64, r);
          return r;
        }
        if (e.status === 429) return { error: 'rate_limited' };
        return { error: e.message };
      }
    }

    if (!json || json.success === false) {
      log('[steam ' + steamid64 + '] success=false → private');
      const r = { is_private: true };
      await idbSetInv(steamid64, r);
      return r;
    }
    if (!Array.isArray(json.descriptions)) {
      log('[steam ' + steamid64 + '] no descriptions array — empty inventory');
      const r = { is_private: false, items: [] };
      await idbSetInv(steamid64, r);
      return r;
    }

    // Build description map keyed by classid_instanceid
    const descByKey = new Map();
    for (const d of json.descriptions) {
      if (d?.market_hash_name) {
        descByKey.set(d.classid + '_' + d.instanceid, {
          name: d.market_hash_name,
          icon: d.icon_url || '',
        });
      }
    }
    // Each asset becomes an item with name + icon (duplicates kept for stacks)
    const items = [];
    for (const a of json.assets || []) {
      const d = descByKey.get(a.classid + '_' + a.instanceid);
      if (d) items.push({ name: d.name, icon: d.icon });
    }
    const result = { is_private: false, items };
    log('[steam ' + steamid64 + '] OK — ' + items.length + ' items');
    await idbSetInv(steamid64, result);
    return result;
  }

  // === Compute totals + sorted priced items list ===
  function priceItems(items, prices) {
    let total = 0, counted = 0, missing = 0;
    const priced = [];
    for (const it of items) {
      const p = prices.get(it.name);
      if (typeof p === 'number') {
        total += p; counted++;
        priced.push({ name: it.name, icon: it.icon, price: p });
      } else {
        missing++;
        priced.push({ name: it.name, icon: it.icon, price: null });
      }
    }
    priced.sort((a, b) => (b.price || 0) - (a.price || 0));
    return {
      total_usd: Math.round(total * 100) / 100,
      counted,
      missing,
      priced,
    };
  }

  // === Concurrency-limited parallel ===
  async function withConcurrency(items, n, fn) {
    let idx = 0;
    async function worker() {
      while (idx < items.length) {
        const i = idx++;
        try { await fn(items[i], i); } catch (e) { log('worker error', e); }
      }
    }
    await Promise.all(Array.from({ length: n }, worker));
  }

  // === Inject CSS ===
  const style = document.createElement('style');
  style.textContent = `
    .csli-badge {
      display: inline-block; padding: 2px 8px; margin-left: 6px;
      background: rgba(255,87,34,0.15); color: #ff7043;
      border-radius: 4px; font-size: 11px; font-weight: 600;
      font-variant-numeric: tabular-nums; vertical-align: middle;
      cursor: pointer; user-select: none; transition: background 0.12s;
    }
    .csli-badge:hover { background: rgba(255,87,34,0.3); }
    .csli-badge.private { background: rgba(120,120,120,0.15); color: #888; font-weight: 400; cursor: default; }
    .csli-badge.private:hover { background: rgba(120,120,120,0.15); }
    .csli-badge.loading { background: rgba(120,120,120,0.15); color: #888; font-weight: 400; cursor: default; }
    .csli-badge.loading:hover { background: rgba(120,120,120,0.15); }
    .csli-badge.error { background: rgba(248,113,113,0.15); color: #f87171; cursor: default; }
    .csli-badge.empty { background: rgba(120,120,120,0.12); color: #999; font-weight: 400; cursor: default; }
    .csli-badge.empty:hover { background: rgba(120,120,120,0.12); }
    .csli-badge .csli-count { opacity: 0.65; margin-left: 4px; font-weight: 400; }

    .csli-inv-popup {
      position: fixed; z-index: 100000;
      background: #15181d; border: 1px solid #ff5722; border-radius: 8px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.7);
      padding: 14px; color: #e6e9ee; max-width: 420px; max-height: 70vh;
      overflow-y: auto;
      font-family: -apple-system, "Segoe UI", Roboto, sans-serif;
    }
    .csli-inv-popup h4 {
      margin: 0 0 4px; font-size: 14px; font-weight: 600;
      color: #ff5722;
    }
    .csli-inv-popup .csli-inv-sub {
      font-size: 11px; color: #8a93a0; margin-bottom: 10px;
    }
    .csli-inv-popup .csli-inv-grid {
      display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px;
    }
    .csli-inv-popup .csli-inv-item {
      background: rgba(255,255,255,0.04);
      border-radius: 6px; padding: 6px 4px;
      text-align: center; font-size: 10px;
    }
    .csli-inv-popup .csli-inv-item img {
      width: 64px; height: 48px; object-fit: contain; display: block; margin: 0 auto 4px;
    }
    .csli-inv-popup .csli-inv-name {
      color: #c0c5cd; line-height: 1.2;
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
      overflow: hidden; min-height: 24px;
    }
    .csli-inv-popup .csli-inv-price {
      color: #ff7043; font-weight: 600; margin-top: 2px;
      font-variant-numeric: tabular-nums;
    }
    .csli-inv-popup .csli-inv-price.none { color: #555; font-weight: 400; }
    .csli-inv-popup .csli-inv-close {
      position: absolute; top: 6px; right: 10px;
      background: transparent; border: 0; color: #8a93a0;
      cursor: pointer; font-size: 18px; line-height: 1;
    }
    .csli-inv-popup .csli-inv-close:hover { color: #fff; }
    .csli-inv-popup .csli-inv-empty { color: #8a93a0; font-style: italic; padding: 12px; text-align: center; }
    .csli-total-panel {
      position: fixed; bottom: 20px; right: 20px; z-index: 99999;
      background: #15181d; border: 1px solid #ff5722; border-radius: 8px;
      padding: 12px 16px; color: #e6e9ee;
      font-family: -apple-system, "Segoe UI", Roboto, sans-serif; font-size: 14px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.5); min-width: 220px;
    }
    .csli-total-panel .csli-label {
      font-size: 11px; color: #8a93a0;
      text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 4px;
    }
    .csli-total-panel .csli-value {
      font-size: 22px; font-weight: 600; color: #ff5722;
      font-variant-numeric: tabular-nums;
    }
    .csli-total-panel .csli-progress { font-size: 11px; color: #8a93a0; margin-top: 2px; }
    .csli-total-panel .csli-close {
      position: absolute; top: 4px; right: 8px;
      background: transparent; border: 0; color: #8a93a0;
      cursor: pointer; font-size: 16px; line-height: 1;
    }
    .csli-total-panel .csli-close:hover { color: #fff; }
  `;
  document.head.appendChild(style);

  // === Panel ===
  let panel = null;
  function showPanel() {
    if (panel) return;
    panel = document.createElement('div');
    panel.className = 'csli-total-panel';
    panel.innerHTML =
      '<button class="csli-close" title="Скрыть">×</button>' +
      '<div class="csli-label">Сумма инвентарей сервера</div>' +
      '<div class="csli-value" data-role="total">—</div>' +
      '<div class="csli-progress" data-role="progress"></div>';
    panel.querySelector('.csli-close').onclick = () => { panel.remove(); panel = null; };
    document.body.appendChild(panel);
  }
  function updatePanel(opts) {
    if (!panel) showPanel();
    if (opts.total != null) panel.querySelector('[data-role="total"]').textContent = '$' + opts.total.toFixed(2);
    if (opts.progress != null) panel.querySelector('[data-role="progress"]').textContent = opts.progress;
  }
  function hidePanel() {
    if (panel) { panel.remove(); panel = null; }
  }

  // === Inventory popup (anchored to badge) ===
  let popup = null;
  function closePopup() {
    if (popup) { popup.remove(); popup = null; document.removeEventListener('click', popupOutsideClick, true); }
  }
  function popupOutsideClick(e) {
    if (popup && !popup.contains(e.target) && !e.target.classList?.contains('csli-badge')) {
      closePopup();
    }
  }
  function steamIconUrl(icon) {
    if (!icon) return '';
    return 'https://community.cloudflare.steamstatic.com/economy/image/' + icon + '/96fx64f';
  }
  function openPopup(badge, nick, data) {
    closePopup();
    popup = document.createElement('div');
    popup.className = 'csli-inv-popup';
    const items = data.priced || [];
    const top = items.slice(0, 60); // cap to 60 to keep popup snappy
    const itemsHtml = top.map(it => {
      const safe = (it.name || '').replace(/[<>&"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]));
      const priceHtml = it.price != null
        ? '<div class="csli-inv-price">$' + it.price.toFixed(2) + '</div>'
        : '<div class="csli-inv-price none">—</div>';
      return '<div class="csli-inv-item">' +
        (it.icon ? '<img loading="lazy" src="' + steamIconUrl(it.icon) + '" alt="">' : '') +
        '<div class="csli-inv-name" title="' + safe + '">' + safe + '</div>' +
        priceHtml +
      '</div>';
    }).join('');
    const safeNick = nick.replace(/[<>&"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]));
    popup.innerHTML =
      '<button class="csli-inv-close" title="Закрыть">×</button>' +
      '<h4>' + safeNick + '</h4>' +
      '<div class="csli-inv-sub">' +
        items.length + ' предметов · $' + data.total_usd.toFixed(2) + ' total · ' +
        data.counted + ' с ценой · ' + data.missing + ' без цены' +
      '</div>' +
      (items.length ? '<div class="csli-inv-grid">' + itemsHtml + '</div>' : '<div class="csli-inv-empty">Пустой инвентарь</div>');
    popup.querySelector('.csli-inv-close').onclick = closePopup;

    // Position popup near badge
    document.body.appendChild(popup);
    const rect = badge.getBoundingClientRect();
    const pw = popup.offsetWidth;
    const ph = popup.offsetHeight;
    let left = rect.right + 8;
    let top_ = rect.top;
    if (left + pw > window.innerWidth - 8) left = Math.max(8, rect.left - pw - 8);
    if (top_ + ph > window.innerHeight - 8) top_ = Math.max(8, window.innerHeight - ph - 8);
    popup.style.left = left + 'px';
    popup.style.top = top_ + 'px';

    // Close on outside click (defer to avoid immediate close from current click)
    setTimeout(() => document.addEventListener('click', popupOutsideClick, true), 0);
  }

  // === Fetch player list from Cybershoke ===
  async function fetchCybershokePlayers(ip, port) {
    const r = await fetch('/api/servers/data', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'ip=' + encodeURIComponent(ip) + '&port=' + encodeURIComponent(port),
    });
    if (!r.ok) throw new Error('Cybershoke /api/servers/data: ' + r.status);
    const j = await r.json();
    return j.playersv2 || [];
  }

  // === Badge inject ===
  // Strategy:
  //   1. Primary: find <a href*="/profile/<steamid64>"> (works for logged-in users, robust against truncated nicks)
  //   2. Fallback: text matching (for guest mode without nick links)
  //   3. When matched element is <a>, insert badge AFTER it (as sibling) so click on badge
  //      doesn't trigger profile navigation.
  function normWhitespace(s) {
    return (s || '').replace(/\s+/g, ' ').trim();
  }
  function findByText(modal, nick) {
    const target = normWhitespace(nick);
    const candidates = modal.querySelectorAll('th, td, div, span, a, p, button, li');
    let bestMatch = null;
    for (const el of candidates) {
      const ownText = normWhitespace(
        Array.from(el.childNodes)
          .filter(n => n.nodeType === 3)
          .map(n => n.textContent || '')
          .join('')
      );
      const fullText = normWhitespace(el.textContent);
      if (ownText === target) { bestMatch = el; break; }
      if (!bestMatch && fullText === target && fullText.length < 64) bestMatch = el;
    }
    return bestMatch;
  }
  // Returns badge element or null silently. Caller orchestrates retries.
  function injectBadge(modal, steamid64, nick) {
    // Primary: look up by SteamID via href. Reliable even when nick is truncated by Cybershoke UI.
    const linkSelector = 'a[href*="/profile/' + steamid64 + '"]';
    let target = modal.querySelector(linkSelector);
    if (!target) target = findByText(modal, nick);
    if (!target) return null;
    // If target is <a> (link to profile), insert badge AFTER it (as sibling in parent) —
    // otherwise click on badge would trigger profile navigation.
    const insertAsSibling = target.tagName === 'A' && target.parentElement;
    const parent = insertAsSibling ? target.parentElement : target;
    // Don't duplicate
    let b = parent.querySelector(':scope > .csli-badge');
    if (b) return b;
    b = document.createElement('span');
    b.className = 'csli-badge loading';
    b.textContent = '…';
    if (insertAsSibling) {
      target.insertAdjacentElement('afterend', b);
    } else {
      target.appendChild(b);
    }
    return b;
  }

  // Wait for Cybershoke React to render player rows, then inject badges.
  // Initial pass + MutationObserver watching for late-rendered rows. Gives up after maxWaitMs.
  function injectAllBadges(modal, withIds, badges, maxWaitMs = 5000) {
    const pending = new Map(withIds.map(p => [p.steamid64, p]));
    function tryInject(p) {
      const b = injectBadge(modal, p.steamid64, p.name);
      if (b) { badges.set(p.steamid64, b); pending.delete(p.steamid64); }
    }
    // Initial pass
    for (const p of [...pending.values()]) tryInject(p);
    if (pending.size === 0) return Promise.resolve();
    log('Waiting for ' + pending.size + ' player rows to render…');
    return new Promise((resolve) => {
      let timeout;
      const observer = new MutationObserver(() => {
        for (const p of [...pending.values()]) tryInject(p);
        if (pending.size === 0) {
          observer.disconnect();
          clearTimeout(timeout);
          log('All badges injected.');
          resolve();
        }
      });
      observer.observe(modal, { childList: true, subtree: true });
      timeout = setTimeout(() => {
        observer.disconnect();
        for (const p of pending.values()) {
          log('[badge] gave up for steamid', p.steamid64, 'nick', JSON.stringify(p.name));
        }
        resolve();
      }, maxWaitMs);
    });
  }

  // === State ===
  let currentServerKey = null;
  let totalUsd = 0;
  let done = 0, plannedTotal = 0;

  // === Main per-server handler ===
  async function handleServerOpen(modal, ip, port) {
    const key = ip + ':' + port;
    if (currentServerKey === key) return;
    currentServerKey = key;
    log('Server opened:', key);

    showPanel();
    totalUsd = 0; done = 0; plannedTotal = 0;
    updatePanel({ total: 0, progress: 'Загрузка игроков и цен…' });

    // Kick off prices fetch in parallel with player fetch
    const pricesP = getPriceMap().catch(e => { log('prices error', e); return new Map(); });

    let players;
    try {
      players = await fetchCybershokePlayers(ip, port);
    } catch (e) {
      log('cybershoke error', e);
      updatePanel({ progress: 'Cybershoke: ' + e.message });
      return;
    }

    const withIds = players.filter(p => p.steamid64);
    log(withIds.length + '/' + players.length + ' players have steamid64');
    if (withIds.length === 0) {
      updatePanel({ progress: 'У игроков нет SteamID. Залогиньтесь на Cybershoke.' });
      return;
    }

    // Initialize badges. Cybershoke React may still be rendering player rows —
    // injectAllBadges waits for them via MutationObserver (up to 5s).
    const badges = new Map();
    await injectAllBadges(modal, withIds, badges);

    // Wait for prices
    const prices = await pricesP;
    log('Prices ready: ' + prices.size + ' items');

    plannedTotal = withIds.length;
    updatePanel({ progress: '0/' + plannedTotal + ' инвентарей загружено' });

    // Stats counters
    let priced = 0, priv = 0, errs = 0, empty = 0;

    await withConcurrency(withIds, STEAM_CONCURRENCY, async (p) => {
      if (currentServerKey !== key) return; // user switched servers
      const b = badges.get(p.steamid64);
      const inv = await fetchSteamInventory(p.steamid64);
      if (currentServerKey !== key) return;
      if (inv.is_private) {
        if (b) { b.className = 'csli-badge private'; b.textContent = '🔒'; b.title = 'Инвентарь скрыт'; b.onclick = null; }
        priv++;
      } else if (inv.error) {
        if (b) { b.className = 'csli-badge error'; b.textContent = '!'; b.title = inv.error; b.onclick = null; }
        errs++;
      } else if (!inv.items || inv.items.length === 0) {
        if (b) { b.className = 'csli-badge empty'; b.textContent = '📭 пусто'; b.title = 'Инвентарь пуст'; b.onclick = null; }
        empty++;
      } else {
        const data = priceItems(inv.items, prices);
        if (b) {
          b.className = 'csli-badge';
          b.innerHTML = '$' + data.total_usd.toFixed(0) + '<span class="csli-count">· ' + inv.items.length + '</span>';
          b.title = 'Клик — показать скины';
          // Stash data on badge for popup
          b._csliData = data;
          b._csliNick = p.name;
          b.onclick = (e) => {
            // preventDefault + stopPropagation: badge is sibling of <a> now (see injectBadge),
            // but still guard against any bubble-up that could trigger navigation.
            e.preventDefault();
            e.stopPropagation();
            openPopup(b, p.name, data);
          };
        }
        totalUsd += data.total_usd;
        priced++;
      }
      done++;
      updatePanel({
        total: totalUsd,
        progress: done + '/' + plannedTotal + ' · ' + priced + ' 💰 · ' + empty + ' 📭 · ' + priv + ' 🔒 · ' + errs + ' !',
      });
    });

    log('Done. Total $' + totalUsd.toFixed(2));
  }

  // === Detect server modal via DOM ===
  function extractIpPort(modal) {
    const m = (modal.innerText || '').match(/IP\s+(\d{1,3}(?:\.\d{1,3}){3})[:\s]+(\d{1,5})/);
    return m ? { ip: m[1], port: m[2] } : null;
  }
  let pendingTimer = null;
  function checkForModal() {
    const modal = document.querySelector('.modal__overlay_SERVER_MODAL');
    if (!modal) {
      if (currentServerKey) {
        log('Server modal closed');
        currentServerKey = null;
        hidePanel();
        closePopup();
      }
      return;
    }
    if (pendingTimer) return;
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      const ipPort = extractIpPort(modal);
      if (!ipPort) return;
      handleServerOpen(modal, ipPort.ip, ipPort.port);
    }, 600);
  }
  const observer = new MutationObserver(checkForModal);
  observer.observe(document.body, { childList: true, subtree: true });
  checkForModal();

  log('Cybershoke Inventory Live v0.5.1 ready (IndexedDB + late-render badge injection).');
  log('Клик на бейдж $XX → попап со скинами. Команды: csliClearCache()');
})();
