const path = require('path');
const express = require('express');
const { Store } = require('./store');
const { createPayPal } = require('./paypal');
const { Orders } = require('./orders');
const { runAgent, stockView, mandateView } = require('./agent');
const { spentThisMonth, evaluate } = require('./policy');
const { parseMandate } = require('./mandate-text');

function createApp(opts = {}) {
  const port = opts.port || process.env.PORT || 3000;
  const baseUrl = (opts.baseUrl || process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${port}`).replace(/\/$/, '');
  const store = opts.store || new Store(process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'state.json'));
  const paypal = opts.paypal || createPayPal({ baseUrl });
  const orders = new Orders({ store, paypal, baseUrl });

  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.use('/vendor/ag-grid', express.static(path.join(__dirname, '..', 'node_modules', 'ag-grid-community')));

  // ---- live updates (Server-Sent Events) ----
  const clients = new Set();
  const send = (event, data) => {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(msg);
  };
  store.onChange(() => send('state', snapshot()));

  app.get('/api/events', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    res.write(`event: state\ndata: ${JSON.stringify(snapshot())}\n\n`);
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => {
      clearInterval(ping);
      clients.delete(res);
    });
  });

  function snapshot() {
    const s = store.state;
    return {
      company: s.company,
      mode: { paypal: paypal.mode, agent: process.env.ANTHROPIC_API_KEY ? 'claude' : 'rules', model: process.env.ANTHROPIC_API_KEY ? (process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5') : null },
      mandate: { ...s.mandate, view: mandateView(s), spent: spentThisMonth(s) },
      suppliers: s.suppliers,
      agents: (s.agents || []).map((a) => ({ ...a, spent: spentThisMonth(s, new Date(), a.id) })),
      stock: stockView(s),
      orders: s.orders,
      totals: orders.totals(),
      audit: s.audit.slice(0, 80),
      running,
      serverTime: new Date().toISOString(),
    };
  }

  const wrap = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (e) {
      res.status(e.status === 401 ? 401 : 400).json({ error: e.message });
    }
  };

  app.get('/api/state', (req, res) => res.json(snapshot()));
  app.get('/api/health', (req, res) => res.json({ ok: true, paypal: paypal.mode }));

  // ---- agent ----
  let running = false;
  app.post('/api/agent/run', wrap(async (req, res) => {
    if (running) return res.status(409).json({ error: 'The agent is already running.' });
    running = true;
    const runId = store.nextId('RUN');
    const instruction = String((req.body && req.body.instruction) || '').slice(0, 500);
    const pending = [];
    res.json({ runId });
    send('state', snapshot());
    const emit = (step) => send('trace', { runId, at: new Date().toISOString(), ...step });
    try {
      store.audit('Reorder agent', 'agent.run', instruction ? `Run started: "${instruction}"` : 'Run started.', runId);
      await runAgent({
        state: store.state,
        instruction,
        emit,
        onProposal: (v, input) => {
          const order = orders.create(v, input);
          if (order.status === 'PAYING') pending.push(orders.payAuto(order));
        },
      });
      await Promise.all(pending);
    } catch (e) {
      emit({ kind: 'error', text: e.message });
      store.audit('Reorder agent', 'agent.error', e.message, runId);
    } finally {
      running = false;
      store.save();
      emit({ kind: 'done' });
    }
  }));

  // ---- mandate ----
  app.put('/api/mandate', wrap(async (req, res) => {
    const m = store.state.mandate;
    const b = req.body || {};
    const num = (k, min, max) => {
      if (b[k] === undefined) return;
      const v = Number(b[k]);
      if (!Number.isFinite(v) || v < min || v > max) throw new Error(`${k} must be between ${min} and ${max}.`);
      m[k] = v;
    };
    num('monthlyCap', 0, 1e6);
    num('perOrderCap', 0, 1e6);
    num('autoApproveBelow', 0, 1e6);
    num('maxPriceIncreasePct', 0, 100);
    num('undoWindowSec', 10, 86400);
    if (typeof b.active === 'boolean') m.active = b.active;
    if (Array.isArray(b.allowedSupplierIds)) m.allowedSupplierIds = b.allowedSupplierIds.filter((id) => store.supplier(id));
    if (Array.isArray(b.allowedCategories)) m.allowedCategories = b.allowedCategories.map(String);
    if (typeof b.plainText === 'string') m.plainText = b.plainText.slice(0, 1000);
    m.version = (m.version || 1) + 1;
    store.audit(store.state.company.buyer, 'mandate.updated', `Mandate updated: €${m.monthlyCap}/month, €${m.perOrderCap}/order, auto-pay below €${m.autoApproveBelow}${m.active ? '' : ', PAUSED'}.`);
    store.save();
    res.json({ ok: true });
  }));

  // Plain-English mandate: returns proposed changes for the buyer to confirm.
  app.post('/api/mandate/parse', wrap(async (req, res) => {
    const text = String((req.body && req.body.text) || '').trim().slice(0, 1000);
    if (!text) throw new Error('Describe the mandate in a sentence or two.');
    res.json(await parseMandate(text, store.state));
  }));

  // Kill switch: pause all agents and void every open authorization.
  app.post('/api/kill', wrap(async (req, res) => {
    res.json(await orders.killSwitch(store.state.company.buyer));
  }));

  app.patch('/api/agents/:id', wrap(async (req, res) => {
    const a = (store.state.agents || []).find((x) => x.id === req.params.id);
    if (!a) throw new Error('Unknown agent.');
    if (typeof req.body.active === 'boolean') a.active = req.body.active;
    if (req.body.monthlyCap !== undefined) {
      const v = Number(req.body.monthlyCap);
      if (!Number.isFinite(v) || v < 0) throw new Error('Agent budget must be a positive number.');
      a.monthlyCap = v;
    }
    store.audit(store.state.company.buyer, 'agent.updated', `${a.name}: ${a.active ? 'active' : 'paused'}, budget €${a.monthlyCap}/month.`);
    store.save();
    res.json(a);
  }));

  // ---- external agents (used by the MCP server) ----
  const agentAuth = (req) => {
    const need = process.env.MANDATE_AGENT_TOKEN;
    if (need && req.get('authorization') !== `Bearer ${need}`) {
      const e = new Error('Missing or wrong agent token.');
      e.status = 401;
      throw e;
    }
    const a = (store.state.agents || []).find((x) => x.id === req.params.id);
    if (!a) throw new Error(`Unknown agent "${req.params.id}".`);
    return a;
  };
  app.get('/api/agents/:id/context', wrap(async (req, res) => {
    const a = agentAuth(req);
    res.json({ agent: a, mandate: mandateView(store.state), agentSpent: spentThisMonth(store.state, new Date(), a.id), catalogue: stockView(store.state) });
  }));
  app.post('/api/agents/:id/check', wrap(async (req, res) => {
    agentAuth(req);
    const v = evaluate(store.state, { agentId: req.params.id, lines: req.body.lines, note: req.body.note });
    res.json({ decision: v.decision, total: v.total, checks: v.checks, budget: v.budget });
  }));
  app.post('/api/agents/:id/purchase', wrap(async (req, res) => {
    const a = agentAuth(req);
    const v = evaluate(store.state, { agentId: a.id, lines: req.body.lines, note: req.body.note });
    send('trace', { runId: 'external', at: new Date().toISOString(), kind: 'proposal', decision: v.decision, total: v.total,
      text: `${a.name} requested ${v.lines.map((l) => `${l.qty.toLocaleString('en')} × ${l.sku}`).join(', ') || 'nothing valid'} for €${v.total.toFixed(2)}.`, reasons: v.reasons, checks: v.checks });
    const order = orders.create(v, { note: req.body.note || '' });
    if (order.status === 'PAYING') await orders.payAuto(order);
    res.json({ orderId: order.id, status: order.status, decision: v.decision, total: v.total, checks: v.checks, undoUntil: order.undoUntil });
  }));
  app.get('/api/agents/:id/orders/:orderId', wrap(async (req, res) => {
    agentAuth(req);
    const o = store.order(req.params.orderId);
    if (!o || o.agentId !== req.params.id) throw new Error('Order not found for this agent.');
    res.json({ orderId: o.id, status: o.status, total: o.total, supplier: o.supplierName, undoUntil: o.undoUntil });
  }));

  // ---- PayPal webhooks ----
  app.post('/paypal/webhook', express.json({ type: '*/*' }), wrap(async (req, res) => {
    const ok = await paypal.verifyWebhook(req.headers, req.body);
    if (!ok) return res.status(400).json({ error: 'Webhook signature not verified.' });
    orders.reconcile(req.body);
    res.json({ ok: true });
  }));

  app.post('/api/mandate/connect', wrap(async (req, res) => {
    const r = await paypal.createVaultSetup({ returnUrl: `${baseUrl}/paypal/vault/return`, cancelUrl: `${baseUrl}/paypal/vault/cancel` });
    store.audit(store.state.company.buyer, 'vault.started', 'Started saving PayPal as the mandate payment method.');
    store.save();
    res.json({ approveUrl: r.approveUrl });
  }));

  app.post('/api/mandate/disconnect', wrap(async (req, res) => {
    store.state.mandate.vaultId = null;
    store.state.mandate.vaultLabel = null;
    store.audit(store.state.company.buyer, 'vault.removed', 'Removed the saved PayPal payment method. Agent payments now need approval.');
    store.save();
    res.json({ ok: true });
  }));

  app.get('/paypal/vault/return', wrap(async (req, res) => {
    const token = req.query.approval_token_id || req.query.token;
    const r = await paypal.createPaymentToken(token);
    store.state.mandate.vaultId = r.vaultId;
    store.state.mandate.vaultLabel = r.label;
    store.state.mandate.vaultBlocked = false;
    store.audit(store.state.company.buyer, 'vault.saved', `PayPal saved for the mandate (${r.label}). The agent can now pay within the limits.`);
    store.save();
    res.redirect('/?notice=paypal-connected');
  }));
  app.get('/paypal/vault/cancel', (req, res) => res.redirect('/?notice=paypal-cancelled'));

  // ---- orders ----
  const find = (req) => {
    const o = store.order(req.params.id);
    if (!o) throw new Error(`Order ${req.params.id} not found.`);
    return o;
  };
  app.post('/api/orders/:id/approve', wrap(async (req, res) => {
    const url = await orders.startApproval(find(req));
    res.json({ approveUrl: url });
  }));
  app.post('/api/orders/:id/reject', wrap(async (req, res) => res.json(orders.reject(find(req)))));
  app.post('/api/orders/:id/undo', wrap(async (req, res) => res.json(await orders.undo(find(req), store.state.company.buyer))));

  app.get('/paypal/order/return', wrap(async (req, res) => {
    await orders.completeApproval(String(req.query.ref));
    res.redirect(`/?notice=approved&order=${encodeURIComponent(req.query.ref)}`);
  }));
  app.get('/paypal/order/cancel', (req, res) => {
    orders.cancelApproval(String(req.query.ref));
    res.redirect('/?notice=approval-cancelled');
  });

  app.post('/api/reset', wrap(async (req, res) => {
    if (running) throw new Error('Wait for the agent to finish.');
    const keepVault = store.state.mandate.vaultId && paypal.mode !== 'simulated' ? { vaultId: store.state.mandate.vaultId, vaultLabel: store.state.mandate.vaultLabel } : null;
    store.reset();
    if (keepVault) Object.assign(store.state.mandate, keepVault);
    store.audit('System', 'demo.reset', 'Demo data reset.');
    store.save();
    res.json({ ok: true });
  }));

  // ---- simulated PayPal approval page (only when no credentials) ----
  app.get('/simulated-paypal/approve', (req, res) => {
    if (paypal.mode !== 'simulated') return res.status(404).end();
    const { kind, token, amount, currency } = req.query;
    const esc = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const what = kind === 'vault'
      ? 'Save PayPal so <b>Mandate</b> can pay suppliers for Northwind Coffee Co. within the limits you set. You can remove it at any time.'
      : `Approve a payment of <b>${esc(currency)} ${esc(amount)}</b> to <b>Mandate</b>. Funds are held, then sent to the supplier after the undo window.`;
    res.send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>PayPal (simulated)</title>
<style>body{font:16px system-ui;background:#f5f7fa;margin:0;display:grid;place-items:center;min-height:100vh;padding:16px}main{background:#fff;max-width:420px;padding:28px;border-radius:12px;box-shadow:0 2px 12px #0001}h1{font-size:20px;margin:0 0 4px;color:#003087}small{color:#6c7378}p{line-height:1.5}button{font:600 16px system-ui;width:100%;padding:12px;border-radius:24px;border:0;margin-top:8px;cursor:pointer}.y{background:#ffc439;color:#111}.n{background:#eef1f5;color:#111}</style>
<main><h1>PayPal</h1><small>Simulated sandbox. Set PAYPAL_CLIENT_ID to use the real PayPal sandbox.</small>
<p>${what}</p><p><small>Signed in as buyer-sandbox@northwind.example</small></p>
<form method="post"><input type="hidden" name="token" value="${esc(token)}"><input type="hidden" name="kind" value="${esc(kind)}">
<input type="hidden" name="return" value="${esc(req.query.return)}"><input type="hidden" name="cancel" value="${esc(req.query.cancel)}">
<button class="y" name="action" value="approve">${kind === 'vault' ? 'Agree and save' : 'Approve payment'}</button>
<button class="n" name="action" value="cancel">Cancel</button></form></main>`);
  });
  app.post('/simulated-paypal/approve', (req, res) => {
    if (paypal.mode !== 'simulated') return res.status(404).end();
    const { token, kind, action } = req.body;
    const safe = (u) => (String(u).startsWith(baseUrl) ? u : '/');
    if (action !== 'approve') return res.redirect(safe(req.body.cancel));
    paypal.markApproved(token);
    const ret = new URL(safe(req.body.return), baseUrl);
    if (kind === 'vault') ret.searchParams.set('approval_token_id', token);
    else {
      ret.searchParams.set('token', token);
      ret.searchParams.set('PayerID', 'SIMPAYER');
    }
    res.redirect(ret.pathname + ret.search);
  });

  // Capture authorizations whose undo window has closed.
  const timer = setInterval(() => orders.sweep().catch(() => {}), opts.sweepMs || 2000);
  timer.unref();

  return { app, store, paypal, orders, baseUrl, port, stop: () => clearInterval(timer) };
}

if (require.main === module) {
  const { app, port, paypal, baseUrl } = createApp();
  app.listen(port, () => {
    console.log(`Mandate running at ${baseUrl}`);
    console.log(`PayPal: ${paypal.mode}. Agent: ${process.env.ANTHROPIC_API_KEY ? 'Claude' : 'deterministic planner (set ANTHROPIC_API_KEY for Claude)'}.`);
  });
}

module.exports = { createApp };
