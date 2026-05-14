# Cybershoke Inventory Live

Tampermonkey userscript + Vercel serverless backend. Показывает цены Steam-инвентарей всех игроков на сервере Cybershoke и общую сумму прямо в UI Cybershoke.

## Архитектура

```
[ Браузер на cybershoke.net ]
    │
    ├──► userscript (Tampermonkey)
    │       │
    │       ├──► /api/servers/data (same-origin, использует вашу Cybershoke-сессию)
    │       │    → получает SteamID игроков
    │       │
    │       └──► POST /api/inventory-batch [SteamID, ...]   (наш Vercel backend)
    │                                  │
    │                                  ├──► steamcommunity.com/inventory/{id}/730/2
    │                                  └──► api.skinport.com/v1/items
    │                                  → возвращает суммы
    │
    └──► UI: цифры рядом с никами + общая панель
```

**Почему такая архитектура:** Cybershoke агрессивно блокирует server-side scraper'ы через Cloudflare. Поэтому Cybershoke-данные забирает userscript из вашей логин-сессии (это работает 100%), а наш backend делает только то что Cybershoke не блокирует — Steam-инвентари + Skinport-цены.

## Установка

1. Поставьте [Tampermonkey](https://www.tampermonkey.net/) (Chrome/Firefox/Edge)
2. Откройте `https://your-app.vercel.app/cybershoke-inventory.user.js` — Tampermonkey предложит установку
3. Откройте `cybershoke.net`, залогиньтесь через Steam, кликните на любой сервер с игроками

## Локальная разработка

```bash
npm install
npx vercel dev    # запускает на http://localhost:3000
```

В консоли cybershoke.net выполните один раз:
```js
csliSetBackend('http://localhost:3000')
```

## Деплой

```bash
npx vercel link        # один раз, интерактивно
npx vercel --prod
```

После деплоя обновите backend URL в userscript:
```js
csliSetBackend('https://your-app.vercel.app')
```

## Структура

```
api/
  inventory-batch.js          POST /api/inventory-batch — главный endpoint
  _lib/
    steam.js                  Steam inventory client
    prices.js                 Skinport price loader (~18k цен, кеш 1ч)
    cache.js                  TTL memo
public/
  index.html                  лендинг с install-кнопкой
  cybershoke-inventory.user.js userscript (отдаётся как статика)
  css/styles.css
userscript/
  cybershoke-inventory.user.js исходник (синхронизируется с public/)
scripts/
  smoke-batch.mjs             smoke-test inventory-batch
  smoke-prices-steam.mjs      проверка Skinport + Steam в изоляции
```

## Известные ограничения

- Steam агрессивно rate-limit'ит inventory endpoint → backend кеширует 1 час на SteamID
- Skinport покрывает ~95% популярных скинов CS2; редкие/legacy предметы не учитываются
- Если у Cybershoke сменится структура `/api/servers/data` или selectors модала — нужно правка userscript
- Cookie/сессия Cybershoke не нужна нашему backend'у — userscript сам берёт данные из вашей залогиненной сессии
