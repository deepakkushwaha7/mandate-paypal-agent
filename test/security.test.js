const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../src/server');
const { Store } = require('../src/store');
const { PayPalSimulator } = require('../src/paypal');
const { Orders } = require('../src/orders');
const { evaluate } = require('../src/policy');

async function withServer(fn, env = {}) {
  const old = { ...process.env };
  Object.assign(process.env, env);
  const { app, store, stop } = createApp({ store: new Store(null), baseUrl: 'http://127.0.0.1:0', sweepMs: 60000 });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base, store);
  } finally {
    server.close();
    stop();
    process.env = old;
  }
}

test('security headers are set on every response', () =>
  withServer(async (base) => {
    const r = await fetch(`${base}/`);
    assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
    assert.equal(r.headers.get('x-powered-by'), null);
  }));

test('cross-site writes are blocked; same-origin writes pass', () =>
  withServer(async (base, store) => {
    const evil = await fetch(`${base}/api/kill`, { method: 'POST', headers: { Origin: 'https://evil.example' } });
    assert.equal(evil.status, 403);
    assert.equal(store.state.mandate.active, true);
    const evil2 = await fetch(`${base}/api/kill`, { method: 'POST', headers: { 'Sec-Fetch-Site': 'cross-site' } });
    assert.equal(evil2.status, 403);
    const ok = await fetch(`${base}/api/kill`, { method: 'POST', headers: { Origin: base } });
    assert.equal(ok.status, 200);
    assert.equal(store.state.mandate.active, false);
  }));

test('agent API requires the token when one is configured', () =>
  withServer(async (base) => {
    const no = await fetch(`${base}/api/agents/claude-desktop/context`);
    assert.equal(no.status, 401);
    const yes = await fetch(`${base}/api/agents/claude-desktop/context`, { headers: { Authorization: 'Bearer s3cret' } });
    assert.equal(yes.status, 200);
  }, { MANDATE_AGENT_TOKEN: 's3cret' }));

test('oversized bodies and floods are rejected', () =>
  withServer(async (base) => {
    const big = await fetch(`${base}/api/mandate/parse`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'x'.repeat(100000) }) });
    assert.equal(big.status, 413);
    let last;
    for (let i = 0; i < 6; i++) last = await fetch(`${base}/api/state`);
    assert.equal(last.status, 429);
  }, { RATE_LIMIT_PER_MIN: '5' }));

test('reset is disabled outside demo mode', () =>
  withServer(async (base) => {
    const r = await fetch(`${base}/api/reset`, { method: 'POST' });
    assert.equal(r.status, 400);
  }, { DEMO_MODE: 'false' }));

test('a double-click cannot undo the same payment twice', async () => {
  const store = new Store(null);
  const paypal = new PayPalSimulator({ baseUrl: 'http://t' });
  const orders = new Orders({ store, paypal, baseUrl: 'http://t' });
  store.state.mandate.vaultId = 'V';
  const o = orders.create(evaluate(store.state, { lines: [{ sku: 'TIS-A3-GOLD', qty: 1000 }] }), {});
  await orders.payAuto(o);
  const results = await Promise.allSettled([
    orders.lock(o.id, () => orders.undo(o, 'a')),
    orders.lock(o.id, () => orders.undo(o, 'b')),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(paypal.calls.filter((c) => c.op === 'authorizations.void').length, 1);
});
