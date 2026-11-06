const test = require('node:test');
const assert = require('node:assert');
const { Store } = require('../src/store');
const { evaluate } = require('../src/policy');
const { PayPalSimulator, purchaseUnit } = require('../src/paypal');
const { Orders } = require('../src/orders');
const { runAgent, planHeuristic } = require('../src/agent');
const { createApp } = require('../src/server');

delete process.env.ANTHROPIC_API_KEY;
delete process.env.PAYPAL_CLIENT_ID;

function fresh() {
  const store = new Store(null);
  const paypal = new PayPalSimulator({ baseUrl: 'http://test' });
  const orders = new Orders({ store, paypal, baseUrl: 'http://test' });
  return { store, paypal, orders };
}

test('small in-policy order is auto-paid only when PayPal is saved', () => {
  const { store } = fresh();
  const p = { lines: [{ sku: 'TIS-A3-GOLD', qty: 1500 }] };
  assert.equal(evaluate(store.state, p).decision, 'needs_approval');
  store.state.mandate.vaultId = 'VAULT-1';
  const v = evaluate(store.state, p);
  assert.equal(v.decision, 'auto');
  assert.equal(v.total, 165);
});

test('prices come from the catalogue, not the proposal', () => {
  const { store } = fresh();
  const v = evaluate(store.state, { lines: [{ sku: 'TIS-A3-GOLD', qty: 1500, unitPrice: 0.0001 }] });
  assert.equal(v.total, 165);
});

test('blocks suppliers and categories outside the mandate', () => {
  const { store } = fresh();
  store.state.mandate.vaultId = 'V';
  const v = evaluate(store.state, { lines: [{ sku: 'TOTE-CANVAS', qty: 150 }] });
  assert.equal(v.decision, 'blocked');
  const codes = v.reasons.map((r) => r.code);
  assert.ok(codes.includes('SUPPLIER_NOT_ALLOWED'));
  assert.ok(codes.includes('CATEGORY_NOT_ALLOWED'));
});

test('blocks MOQ, pack size, mixed suppliers and caps', () => {
  const { store } = fresh();
  store.state.mandate.vaultId = 'V';
  const codes = (p) => evaluate(store.state, p).reasons.map((r) => r.code);
  assert.ok(codes({ lines: [{ sku: 'MBX-S-KRAFT', qty: 100 }] }).includes('BELOW_MOQ'));
  assert.ok(codes({ lines: [{ sku: 'MBX-S-KRAFT', qty: 260 }] }).includes('PACK_SIZE'));
  assert.ok(codes({ lines: [{ sku: 'MBX-S-KRAFT', qty: 250 }, { sku: 'TIS-A3-GOLD', qty: 1000 }] }).includes('MULTI_SUPPLIER'));
  assert.ok(codes({ lines: [{ sku: 'MBX-M-KRAFT', qty: 2000 }] }).includes('PER_ORDER_CAP'));
  store.state.mandate.openingSpend = 2450;
  assert.ok(codes({ lines: [{ sku: 'TIS-A3-GOLD', qty: 1000 }] }).includes('MONTHLY_CAP'));
});

test('supplier price rise above the limit needs a human', () => {
  const { store } = fresh();
  store.state.mandate.vaultId = 'V';
  store.state.mandate.autoApproveBelow = 10000;
  const v = evaluate(store.state, { lines: [{ sku: 'MBX-S-KRAFT', qty: 250 }] });
  assert.equal(v.decision, 'needs_approval');
  assert.ok(v.reasons.some((r) => r.code === 'PRICE_DRIFT'));
});

test('paused mandate blocks everything', () => {
  const { store } = fresh();
  store.state.mandate.active = false;
  assert.equal(evaluate(store.state, { lines: [{ sku: 'TIS-A3-GOLD', qty: 1000 }] }).decision, 'blocked');
});

test('PayPal amounts are exact two-decimal pack prices', () => {
  const { store } = fresh();
  const v = evaluate(store.state, { lines: [{ sku: 'STK-60-ROUND', qty: 3000 }, { sku: 'LBL-BAG-250', qty: 2000 }] });
  const pu = purchaseUnit({ id: 'PO-1', currency: 'EUR', supplierName: 'X', lines: v.lines }, store.state.catalogue);
  assert.deepEqual(pu.items.map((i) => [i.quantity, i.unit_amount.value]), [['3', '45.00'], ['2', '70.00']]);
  assert.equal(pu.amount.value, '275.00');
  assert.equal(Number(pu.amount.value), v.total);
});

test('planner finds low-cover SKUs and groups per supplier', () => {
  const { store } = fresh();
  const { needs, bySupplier } = planHeuristic(store.state, '');
  assert.deepEqual(needs.map((n) => n.sku).sort(), ['LBL-BAG-250', 'MBX-S-KRAFT', 'TIS-A3-GOLD', 'TOTE-CANVAS']);
  assert.equal(bySupplier.size, 4);
  for (const n of needs) assert.equal(n.qty % n.packSize, 0);
});

test('full agent run: auto-pay, approval, block; undo voids; window captures; undo after capture refunds', async () => {
  const { store, paypal, orders } = fresh();
  store.state.mandate.vaultId = 'VAULT-X';
  const steps = [];
  const pending = [];
  await runAgent({
    state: store.state,
    instruction: '',
    emit: (s) => steps.push(s),
    onProposal: (v, input) => {
      const o = orders.create(v, input);
      if (o.status === 'PAYING') pending.push(orders.payAuto(o));
    },
  });
  await Promise.all(pending);
  const by = (sku) => store.state.orders.find((o) => o.lines.some((l) => l.sku === sku) || (o.status === 'BLOCKED' && o.reasons.some((r) => r.message.includes(sku))));
  assert.equal(by('TIS-A3-GOLD').status, 'AUTHORIZED');
  assert.equal(by('LBL-BAG-250').status, 'AUTHORIZED');
  assert.equal(by('MBX-S-KRAFT').status, 'NEEDS_APPROVAL');
  assert.equal(by('TOTE-CANVAS').status, 'BLOCKED');
  assert.ok(steps.some((s) => s.kind === 'finish'));

  // Undo inside the window voids the authorization.
  const tissue = by('TIS-A3-GOLD');
  await orders.undo(tissue, 'Priya');
  assert.equal(tissue.status, 'VOIDED');

  // Window closes -> capture.
  const labels = by('LBL-BAG-250');
  const before = store.state.inventory.find((i) => i.sku === 'LBL-BAG-250').onHand;
  await orders.sweep(Date.now() + 3600e3);
  assert.equal(labels.status, 'CAPTURED');
  assert.equal(store.state.inventory.find((i) => i.sku === 'LBL-BAG-250').onHand, before + labels.lines[0].qty);

  // Undo after capture refunds.
  await orders.undo(labels, 'Priya');
  assert.equal(labels.status, 'REFUNDED');
  assert.ok(paypal.calls.some((c) => c.op === 'captures.refund'));

  // Human approval through PayPal.
  const boxes = by('MBX-S-KRAFT');
  const url = await orders.startApproval(boxes);
  assert.match(url, /simulated-paypal\/approve/);
  paypal.markApproved(boxes.paypal.orderId);
  await orders.completeApproval(boxes.id);
  assert.equal(boxes.status, 'AUTHORIZED');
});

test('approval re-checks hard limits at approval time', async () => {
  const { store, orders } = fresh();
  const v = evaluate(store.state, { lines: [{ sku: 'MBX-S-KRAFT', qty: 1250 }] });
  const o = orders.create(v, { note: '' });
  assert.equal(o.status, 'NEEDS_APPROVAL');
  store.state.mandate.monthlyCap = 700;
  await assert.rejects(() => orders.startApproval(o), /Cannot approve/);
});

test('HTTP: run agent, connect PayPal (simulated), approve flow', async () => {
  const { app, store, stop } = createApp({ store: new Store(null), baseUrl: 'http://127.0.0.1:0', sweepMs: 60000 });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const j = (r) => r.json();
    let r = await fetch(`${base}/api/mandate/connect`, { method: 'POST' }).then(j);
    const token = new URL(r.approveUrl).searchParams.get('token');
    // Approve on the simulated PayPal page.
    const form = new URLSearchParams({ token, kind: 'vault', action: 'approve', return: 'http://127.0.0.1:0/paypal/vault/return', cancel: 'http://127.0.0.1:0/' });
    const res = await fetch(`${base}/simulated-paypal/approve`, { method: 'POST', body: form, redirect: 'manual' });
    const loc = res.headers.get('location');
    await fetch(`${base}${loc}`, { redirect: 'manual' });
    assert.ok(store.state.mandate.vaultId);

    await fetch(`${base}/api/agent/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    for (let i = 0; i < 50 && (await fetch(`${base}/api/state`).then(j)).running; i++) await new Promise((x) => setTimeout(x, 20));
    const s = await fetch(`${base}/api/state`).then(j);
    assert.equal(s.orders.length, 4);
    assert.equal(s.orders.filter((o) => o.status === 'AUTHORIZED').length, 2);
    r = await fetch(`${base}/api/state`).then(j);
    assert.ok(r.audit.length > 3);
  } finally {
    server.close();
    stop();
  }
});
