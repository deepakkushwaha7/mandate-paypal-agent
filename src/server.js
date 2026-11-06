const path = require('path');
const express = require('express');
const { createPayPal } = require('./paypal');
const { runAgent, stockView, mandateView } = require('./agent');
const { spentThisMonth, evaluate, evaluateAction, eur } = require('./policy');
const { parseMandate } = require('./mandate-text');
const { Workspaces } = require('./workspace');
const security = require('./security');
const llm = require('./llm');

const COOKIE = 'mandate_ws';

function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

function createApp(opts = {}) {
  const port = opts.port || process.env.PORT || 3000;
  const baseUrl = (opts.baseUrl || process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${port}`).replace(/\/$/, '');
  const paypal = opts.paypal || createPayPal({ baseUrl });
  // opts.store = one shared workspace (tests, single-tenant installs).
  // Otherwise every visitor gets a private workspace.
  const spaces = new Workspaces({ paypal, baseUrl, describeAi: () => llm.describe(), single: opts.store || null });

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(security.headers);
  app.use('/api', security.rateLimit({ max: Number(process.env.RATE_LIMIT_PER_MIN) || 240 }));
  app.use(express.json({ limit: '64kb' }));
  app.use(express.urlencoded({ extended: false, limit: '16kb' }));
  app.use(security.sameOrigin);
  app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '5m' }));
  app.use('/vendor/ag-grid', express.static(path.join(__dirname, '..', 'node_modules', 'ag-grid-community'), { maxAge: '7d', immutable: true }));

  // Resolve (or create) the visitor's workspace from a secure cookie.
  function workspaceFor(req, res) {
    let ws = spaces.get(readCookie(req, COOKIE));
    if (!ws) {
      ws = spaces.create();
      const secure = req.secure || req.get('x-forwarded-proto') === 'https';
      res.setHeader('Set-Cookie', `${COOKIE}=${ws.id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800${secure ? '; Secure' : ''}`);
    }
    return ws;
  }
  const withWs = (req, res, next) => {
    req.ws = workspaceFor(req, res);
    next();
  };

  const wrap = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (e) {
      res.status(e.status === 401 ? 401 : 400).json({ error: e.message });
    }
  };

  app.get('/api/health', (req, res) => res.json({ ok: true, paypal: paypal.mode, ai: llm.describe() }));

  // ---- live updates (Server-Sent Events) ----
  app.get('/api/events', withWs, (req, res) => {
    const ws = req.ws;
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    res.write(`event: state\ndata: ${JSON.stringify(ws.snapshot())}\n\n`);
    ws.clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => {
      clearInterval(ping);
      ws.clients.delete(res);
    });
  });

  app.get('/api/state', withWs, (req, res) => res.json(req.ws.snapshot()));

  // ---- agent ----
  app.post('/api/agent/run', withWs, wrap(async (req, res) => {
    const ws = req.ws;
    const { store, orders } = ws;
    if (ws.running) return res.status(409).json({ error: 'The agent is already running.' });
    ws.running = true;
    const runId = store.nextId('RUN');
    const instruction = String((req.body && req.body.instruction) || '').slice(0, 500);
    const pending = [];
    res.json({ runId });
    ws.send('state', ws.snapshot());
    const emit = (step) => ws.send('trace', { runId, at: new Date().toISOString(), ...step });
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
      ws.running = false;
      store.save();
      emit({ kind: 'done' });
    }
  }));

  // ---- mandate ----
  app.put('/api/mandate', withWs, wrap(async (req, res) => {
    const { store } = req.ws;
    const m = store.state.mandate;
    const b = req.body || {};
    const num = (k, min, max, label) => {
      if (b[k] === undefined) return;
      const v = Number(b[k]);
      if (!Number.isFinite(v) || v < min || v > max) throw new Error(`${label} must be between ${min} and ${max}.`);
      m[k] = v;
    };
    num('monthlyCap', 0, 1e6, 'Monthly budget');
    num('perOrderCap', 0, 1e6, 'Largest order');
    num('autoApproveBelow', 0, 1e6, 'Auto-pay limit');
    num('maxPriceIncreasePct', 0, 100, 'Price rise limit');
    num('undoWindowSec', 10, 86400, 'Undo window');
    if (typeof b.active === 'boolean') m.active = b.active;
    if (Array.isArray(b.allowedSupplierIds)) m.allowedSupplierIds = b.allowedSupplierIds.filter((id) => store.supplier(id));
    if (Array.isArray(b.allowedCategories)) m.allowedCategories = b.allowedCategories.map(String);
    if (typeof b.plainText === 'string') m.plainText = b.plainText.slice(0, 1000);
    m.version = (m.version || 1) + 1;
    store.audit(store.state.company.buyer, 'mandate.updated', m.active
      ? `Rules updated (v${m.version}): ${eur(m.monthlyCap)} a month, ${eur(m.perOrderCap)} per order, auto-pay below ${eur(m.autoApproveBelow)}.`
      : 'Agents resumed spending.');
    store.save();
    res.json({ ok: true });
  }));

  app.post('/api/mandate/parse', withWs, wrap(async (req, res) => {
    const text = String((req.body && req.body.text) || '').trim().slice(0, 1000);
    if (!text) throw new Error('Describe your rules in a sentence or two.');
    res.json(await parseMandate(text, req.ws.state));
  }));

  app.post('/api/kill', withWs, wrap(async (req, res) => {
    res.json(await req.ws.orders.killSwitch(req.ws.state.company.buyer));
  }));

  app.patch('/api/agents/:id', withWs, wrap(async (req, res) => {
    const { store } = req.ws;
    const a = (store.state.agents || []).find((x) => x.id === req.params.id);
    if (!a) throw new Error('Unknown agent.');
    if (typeof req.body.active === 'boolean') a.active = req.body.active;
    if (req.body.monthlyCap !== undefined) {
      const v = Number(req.body.monthlyCap);
      if (!Number.isFinite(v) || v < 0) throw new Error('Agent budget must be a positive number.');
      a.monthlyCap = v;
    }
    store.audit(store.state.company.buyer, 'agent.updated', `${a.name} ${a.active ? 'can spend again' : 'paused'} (budget ${eur(a.monthlyCap)} a month).`);
    store.save();
    res.json(a);
  }));

  // ---- external agents (MCP and PayPal Agent Toolkit guard) ----
  // Multi-workspace: Bearer <workspace agent key>, shown in the dashboard.
  // Single workspace: optional MANDATE_AGENT_TOKEN.
  const agentAuth = (req) => {
    const bearer = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    let ws;
    if (spaces.single) {
      const need = process.env.MANDATE_AGENT_TOKEN;
      if (need && bearer !== need) ws = null;
      else ws = spaces.single;
    } else {
      ws = spaces.byAgentKey(bearer);
    }
    if (!ws) {
      const e = new Error('Missing or wrong agent key. Copy it from the dashboard (Agents → Connect an agent).');
      e.status = 401;
      throw e;
    }
    const a = (ws.state.agents || []).find((x) => x.id === req.params.id);
    if (!a) throw new Error(`Unknown agent "${req.params.id}".`);
    return { ws, agent: a };
  };
  app.get('/api/agents/:id/context', wrap(async (req, res) => {
    const { ws, agent } = agentAuth(req);
    res.json({ agent, mandate: mandateView(ws.state), agentSpent: spentThisMonth(ws.state, new Date(), agent.id), catalogue: stockView(ws.state) });
  }));
  app.post('/api/agents/:id/check', wrap(async (req, res) => {
    const { ws } = agentAuth(req);
    const v = evaluate(ws.state, { agentId: req.params.id, lines: req.body.lines, note: req.body.note });
    res.json({ decision: v.decision, total: v.total, checks: v.checks, budget: v.budget });
  }));
  app.post('/api/agents/:id/purchase', wrap(async (req, res) => {
    const { ws, agent } = agentAuth(req);
    const v = evaluate(ws.state, { agentId: agent.id, lines: req.body.lines, note: req.body.note });
    ws.send('trace', { runId: 'external', at: new Date().toISOString(), kind: 'proposal', decision: v.decision, total: v.total,
      text: `${agent.name} asked to buy ${v.lines.map((l) => `${l.qty.toLocaleString('en')} × ${l.sku}`).join(', ') || 'nothing valid'} for ${eur(v.total)}.`, reasons: v.reasons, checks: v.checks });
    const order = ws.orders.create(v, { note: req.body.note || '' });
    if (order.status === 'PAYING') await ws.orders.payAuto(order);
    res.json({ orderId: order.id, status: order.status, decision: v.decision, total: v.total, checks: v.checks, undoUntil: order.undoUntil });
  }));
  // Pre-flight check for any other PayPal action (refund, invoice, payout)
  // an agent wants to run, e.g. through PayPal's Agent Toolkit. See
  // examples/paypal-agent-toolkit-guard.js.
  app.post('/api/agents/:id/authorize-action', wrap(async (req, res) => {
    const { ws, agent } = agentAuth(req);
    const v = evaluateAction(ws.state, { agentId: agent.id, action: req.body.action, amount: req.body.amount, note: req.body.note });
    const label = { auto: 'allowed', needs_approval: 'held for a human', blocked: 'blocked' }[v.decision];
    ws.store.audit(agent.name, 'action.checked', `${agent.name} asked to run PayPal ${v.action} for ${eur(v.amount || 0)}: ${label}.`);
    ws.store.save();
    res.json(v);
  }));
  app.get('/api/agents/:id/orders/:orderId', wrap(async (req, res) => {
    const { ws } = agentAuth(req);
    const o = ws.store.order(req.params.orderId);
    if (!o || o.agentId !== req.params.id) throw new Error('Order not found for this agent.');
    res.json({ orderId: o.id, status: o.status, total: o.total, supplier: o.supplierName, undoUntil: o.undoUntil });
  }));

  // ---- PayPal webhooks (verified, then applied to whichever workspace owns the payment) ----
  app.post('/paypal/webhook', express.json({ type: '*/*' }), wrap(async (req, res) => {
    const ok = await paypal.verifyWebhook(req.headers, req.body);
    if (!ok) return res.status(400).json({ error: 'Webhook signature not verified.' });
    for (const ws of spaces.all()) if (ws.orders.reconcile(req.body)) break;
    res.json({ ok: true });
  }));

  // ---- saving PayPal for the agents ----
  app.post('/api/mandate/connect', withWs, wrap(async (req, res) => {
    const { store } = req.ws;
    const r = await paypal.createVaultSetup({ returnUrl: `${baseUrl}/paypal/vault/return`, cancelUrl: `${baseUrl}/paypal/vault/cancel` });
    store.audit(store.state.company.buyer, 'vault.started', 'Opened PayPal to save it for the agents.');
    store.save();
    res.json({ approveUrl: r.approveUrl });
  }));

  app.post('/api/mandate/disconnect', withWs, wrap(async (req, res) => {
    const { store } = req.ws;
    store.state.mandate.vaultId = null;
    store.state.mandate.vaultLabel = null;
    store.audit(store.state.company.buyer, 'vault.removed', 'Removed saved PayPal. Every agent payment now needs your approval.');
    store.save();
    res.json({ ok: true });
  }));

  app.get('/paypal/vault/return', withWs, wrap(async (req, res) => {
    const { store } = req.ws;
    const token = req.query.approval_token_id || req.query.token;
    const r = await paypal.createPaymentToken(token);
    store.state.mandate.vaultId = r.vaultId;
    store.state.mandate.vaultLabel = r.label;
    store.state.mandate.vaultBlocked = false;
    store.audit(store.state.company.buyer, 'vault.saved', `PayPal saved (${r.label}). Agents can now pay within your rules.`);
    store.save();
    res.redirect('/?notice=paypal-connected');
  }));
  app.get('/paypal/vault/cancel', (req, res) => res.redirect('/?notice=paypal-cancelled'));

  // ---- orders ----
  const find = (req) => {
    const o = req.ws.store.order(req.params.id);
    if (!o) throw new Error(`Order ${req.params.id} not found.`);
    return o;
  };
  app.post('/api/orders/:id/approve', withWs, wrap(async (req, res) => {
    const o = find(req);
    const url = await req.ws.orders.lock(o.id, () => req.ws.orders.startApproval(o));
    res.json({ approveUrl: url });
  }));
  app.post('/api/orders/:id/reject', withWs, wrap(async (req, res) => {
    const o = find(req);
    res.json(await req.ws.orders.lock(o.id, async () => req.ws.orders.reject(o)));
  }));
  app.post('/api/orders/:id/undo', withWs, wrap(async (req, res) => {
    const o = find(req);
    res.json(await req.ws.orders.lock(o.id, () => req.ws.orders.undo(o, req.ws.state.company.buyer)));
  }));

  app.get('/paypal/order/return', withWs, wrap(async (req, res) => {
    await req.ws.orders.completeApproval(String(req.query.ref));
    res.redirect(`/?notice=approved&order=${encodeURIComponent(req.query.ref)}`);
  }));
  app.get('/paypal/order/cancel', withWs, (req, res) => {
    req.ws.orders.cancelApproval(String(req.query.ref));
    res.redirect('/?notice=approval-cancelled');
  });

  app.post('/api/reset', withWs, wrap(async (req, res) => {
    const ws = req.ws;
    if (process.env.DEMO_MODE === 'false') throw new Error('Reset is turned off outside demo mode.');
    if (ws.running) throw new Error('Wait for the agent to finish.');
    const keepVault = ws.state.mandate.vaultId && paypal.mode !== 'simulated' ? { vaultId: ws.state.mandate.vaultId, vaultLabel: ws.state.mandate.vaultLabel } : null;
    ws.store.reset();
    if (keepVault) Object.assign(ws.state.mandate, keepVault);
    ws.store.audit('System', 'demo.reset', 'Demo restarted with fresh data.');
    ws.store.save();
    res.json({ ok: true });
  }));

  // ---- simulated PayPal approval page (only when no PayPal credentials) ----
  app.get('/simulated-paypal/approve', (req, res) => {
    if (paypal.mode !== 'simulated') return res.status(404).end();
    const { kind, token, amount, currency } = req.query;
    const esc = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const what = kind === 'vault'
      ? 'Save your payment method so <b>Mandate</b> can pay suppliers for Northwind Coffee Co. within the rules you set. You can remove it at any time.'
      : `Approve a payment of <b>${esc(currency)} ${esc(amount)}</b> to <b>Mandate</b>. The money is held first and sent to the supplier after the undo window.`;
    res.send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Payment approval (simulated)</title>
<style>body{font:16px system-ui;background:#f4f6fa;margin:0;display:grid;place-items:center;min-height:100vh;padding:16px;color:#0b1b3f}main{background:#fff;max-width:420px;padding:28px;border-radius:16px;box-shadow:0 4px 24px rgba(11,27,63,.08)}h1{font-size:20px;margin:0 0 4px}small{color:#5a6a85}p{line-height:1.5}button{font:600 16px system-ui;width:100%;padding:12px;border-radius:999px;border:0;margin-top:8px;cursor:pointer}.y{background:#0a5cff;color:#fff}.n{background:#eef2f8;color:#0b1b3f}</style>
<main><h1>Approve with your wallet</h1><small>Simulated approval page. Set PAYPAL_CLIENT_ID to use the real PayPal sandbox.</small>
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

  // Capture authorizations whose undo window has closed, in every workspace.
  const timer = setInterval(() => {
    for (const ws of spaces.all()) ws.orders.sweep().catch(() => {});
  }, opts.sweepMs || 2000);
  timer.unref();

  const first = spaces.single;
  return {
    app,
    spaces,
    paypal,
    baseUrl,
    port,
    store: first ? first.store : null,
    orders: first ? first.orders : null,
    stop: () => clearInterval(timer),
  };
}

if (require.main === module) {
  const { app, port, paypal, baseUrl } = createApp();
  app.listen(port, () => {
    console.log(`Mandate running at ${baseUrl}`);
    const ai = llm.describe();
    console.log(`PayPal: ${paypal.mode}. AI: ${ai ? `${ai.label} (${ai.model})` : 'none, using the built-in planner (set GEMINI_API_KEY)'}.`);
  });
}

module.exports = { createApp };
