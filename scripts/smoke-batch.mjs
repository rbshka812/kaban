// Smoke test for POST /api/inventory-batch
// Mocks Vercel req/res and calls handler directly.

import handler from '../api/inventory-batch.js';

function mockReqRes(method, body, origin = 'https://cybershoke.net') {
  const req = {
    method,
    headers: { 'origin': origin, 'content-type': 'application/json' },
    body,
  };
  const res = {
    _status: 200,
    _headers: {},
    _body: null,
    status(c) { this._status = c; return this; },
    setHeader(k, v) { this._headers[k] = v; return this; },
    json(b) { this._body = b; return this; },
    end() { return this; },
  };
  return { req, res };
}

console.log('=== Preflight (OPTIONS) ===');
{
  const { req, res } = mockReqRes('OPTIONS', null);
  await handler(req, res);
  console.log(`status=${res._status}`);
  console.log('CORS headers:', {
    'allow-origin': res._headers['Access-Control-Allow-Origin'],
    'allow-methods': res._headers['Access-Control-Allow-Methods'],
  });
}

console.log('\n=== POST with empty body ===');
{
  const { req, res } = mockReqRes('POST', {});
  await handler(req, res);
  console.log(`status=${res._status}, body=${JSON.stringify(res._body)}`);
}

console.log('\n=== POST with bad steamid ===');
{
  const { req, res } = mockReqRes('POST', { steamids: ['nope', '12345'] });
  await handler(req, res);
  console.log(`status=${res._status}, body=${JSON.stringify(res._body)}`);
}

console.log('\n=== POST with valid steamids (real ones from main-data recon) ===');
{
  const { req, res } = mockReqRes('POST', {
    steamids: [
      '76561197960287930',          // GabeN
      '76561198207696381',          // from recon
      '76561198000000001',          // probably private
    ],
  });
  const t0 = Date.now();
  await handler(req, res);
  console.log(`status=${res._status} (${Date.now() - t0}ms)`);
  console.log('body:', JSON.stringify(res._body, null, 2));
}

console.log('\n=== Wrong method ===');
{
  const { req, res } = mockReqRes('GET', null);
  await handler(req, res);
  console.log(`status=${res._status}, body=${JSON.stringify(res._body)}`);
}

console.log('\n=== Disallowed origin (CORS not granted) ===');
{
  const { req, res } = mockReqRes('OPTIONS', null, 'https://evil.example.com');
  await handler(req, res);
  console.log(`status=${res._status}, allow-origin=${res._headers['Access-Control-Allow-Origin'] || '(none)'}`);
}
