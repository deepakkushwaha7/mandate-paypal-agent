// A workspace is one buyer's world: their mandate, agents, orders and live
// connections. The hosted demo gives every visitor a private workspace, so
// judges testing at the same time never see each other's clicks.

const crypto = require('crypto');
const { Store } = require('./store');
const { Orders } = require('./orders');
const { stockView, mandateView } = require('./agent');
const { spentThisMonth } = require('./policy');

class Workspace {
  constructor({ id, store, paypal, baseUrl, describeAi }) {
    this.id = id;
    this.store = store;
    this.orders = new Orders({ store, paypal, baseUrl });
    this.paypal = paypal;
    this.describeAi = describeAi;
    this.clients = new Set();
    this.running = false;
    this.lastSeen = Date.now();
    // Bearer key for this workspace's external agents (MCP). Never the session cookie.
    this.agentKey = `mk_${crypto.randomBytes(24).toString('base64url')}`;
    store.onChange(() => this.send('state', this.snapshot()));
  }

  get state() {
    return this.store.state;
  }

  send(event, data) {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of this.clients) res.write(msg);
  }

  snapshot() {
    const s = this.state;
    return {
      company: s.company,
      demoMode: process.env.DEMO_MODE !== 'false',
      mode: { paypal: this.paypal.mode, ai: this.describeAi() },
      mandate: { ...s.mandate, view: mandateView(s), spent: spentThisMonth(s) },
      suppliers: s.suppliers,
      agents: (s.agents || []).map((a) => ({ ...a, spent: spentThisMonth(s, new Date(), a.id) })),
      stock: stockView(s),
      orders: s.orders,
      totals: this.orders.totals(),
      audit: s.audit.slice(0, 80),
      running: this.running,
      agentKey: this.agentKey,
      serverTime: new Date().toISOString(),
    };
  }
}

class Workspaces {
  constructor({ paypal, baseUrl, describeAi, single = null, maxWorkspaces = 2000, idleMs = 12 * 3600000 }) {
    this.paypal = paypal;
    this.baseUrl = baseUrl;
    this.describeAi = describeAi;
    this.maxWorkspaces = maxWorkspaces;
    this.idleMs = idleMs;
    this.byId = new Map();
    this.single = single ? new Workspace({ id: 'single', store: single, paypal, baseUrl, describeAi }) : null;
  }

  create() {
    this.evict();
    const id = crypto.randomBytes(18).toString('base64url');
    const ws = new Workspace({ id, store: new Store(null), paypal: this.paypal, baseUrl: this.baseUrl, describeAi: this.describeAi });
    this.byId.set(id, ws);
    return ws;
  }

  get(id) {
    if (this.single) return this.single;
    const ws = id && this.byId.get(id);
    if (ws) ws.lastSeen = Date.now();
    return ws || null;
  }

  byAgentKey(key) {
    if (!key) return null;
    for (const ws of this.all()) {
      const a = Buffer.from(ws.agentKey);
      const b = Buffer.from(key);
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) return ws;
    }
    return null;
  }

  all() {
    return this.single ? [this.single] : [...this.byId.values()];
  }

  evict(now = Date.now()) {
    for (const [id, ws] of this.byId) {
      if (!ws.running && ws.clients.size === 0 && now - ws.lastSeen > this.idleMs) this.byId.delete(id);
    }
    if (this.byId.size >= this.maxWorkspaces) {
      const oldest = [...this.byId.values()].filter((w) => !w.running).sort((a, b) => a.lastSeen - b.lastSeen);
      for (const ws of oldest.slice(0, this.byId.size - this.maxWorkspaces + 1)) this.byId.delete(ws.id);
    }
  }
}

module.exports = { Workspace, Workspaces };
