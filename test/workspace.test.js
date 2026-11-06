const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../src/server');
const { guardToolkit } = require('../examples/paypal-agent-toolkit-guard');

async function multi(fn) {
  const { app, stop } = createApp({ baseUrl: 'http://127.0.0.1:0', sweepMs: 60000 });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    server.close();
    stop();
  }
}

function client(base) {
  let cookie = '';
  return async (path, opts = {}) => {
    const res = await fetch(base + path, { ...opts, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(opts.headers || {}) } });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return res;
  };
}

test('every visitor gets a private workspace; actions never leak across', () =>
  multi(async (base) => {
    const a = client(base);
    const b = client(base);
    const sa = await (await a('/api/state')).json();
    const sb = await (await b('/api/state')).json();
    assert.notEqual(sa.agentKey, sb.agentKey);
    assert.equal((await a('/api/kill', { method: 'POST' })).status, 200);
    assert.equal((await (await a('/api/state')).json()).mandate.active, false);
    assert.equal((await (await b('/api/state')).json()).mandate.active, true);
  }));

test('session cookie is HttpOnly and SameSite', () =>
  multi(async (base) => {
    const res = await fetch(`${base}/api/state`);
    const c = res.headers.get('set-cookie');
    assert.match(c, /HttpOnly/);
    assert.match(c, /SameSite=Lax/);
  }));

test('agent API uses the workspace agent key and only touches that workspace', () =>
  multi(async (base) => {
    const a = client(base);
    const b = client(base);
    const keyA = (await (await a('/api/state')).json()).agentKey;
    await b('/api/state');
    const no = await fetch(`${base}/api/agents/claude-desktop/context`);
    assert.equal(no.status, 401);
    const auth = { Authorization: `Bearer ${keyA}`, 'Content-Type': 'application/json' };
    const r = await fetch(`${base}/api/agents/claude-desktop/purchase`, { method: 'POST', headers: auth, body: JSON.stringify({ lines: [{ sku: 'LBL-BAG-250', qty: 2000 }], note: 'x' }) });
    assert.equal((await r.json()).decision, 'needs_approval'); // no saved PayPal yet
    assert.equal((await (await a('/api/state')).json()).orders.length, 1);
    assert.equal((await (await b('/api/state')).json()).orders.length, 0);
  }));

test('PayPal Agent Toolkit guard: allowed, held and blocked actions', () =>
  multi(async (base) => {
    const a = client(base);
    const key = (await (await a('/api/state')).json()).agentKey;
    const ran = [];
    const toolkit = { getTools: () => [], handleToolCall: async (c) => { ran.push(c.function.name); return { role: 'tool', tool_call_id: c.id, content: '{"ok":true}' }; } };
    const g = guardToolkit(toolkit, { agentId: 'reorder-agent', mandateUrl: base, agentKey: key });
    const call = (name, args) => g.handleToolCall({ id: name, function: { name, arguments: JSON.stringify(args) } });
    await call('list_transactions', {});
    await call('create_refund', { capture_id: 'X', amount: { value: '50.00', currency_code: 'EUR' } });
    const held = await call('create_refund', { capture_id: 'Y', amount: { value: '450.00', currency_code: 'EUR' } });
    const blocked = await call('create_refund', { capture_id: 'Z', amount: { value: '5000.00', currency_code: 'EUR' } });
    assert.deepEqual(ran, ['list_transactions', 'create_refund']);
    assert.match(held.content, /Held for the buyer/);
    assert.match(blocked.content, /Blocked by the spending mandate/);
    const audit = (await (await a('/api/state')).json()).audit.map((x) => x.message).join('\n');
    assert.match(audit, /create_refund for €450.00: held for a human/);
  }));
