// Order lifecycle. Every state change is written to the audit log.
//
//   BLOCKED          mandate engine refused it; nothing sent to PayPal
//   NEEDS_APPROVAL   waiting for a human to approve in PayPal
//   PAYING           authorization in flight
//   AUTHORIZED       funds held; buyer can Undo (void) until undoUntil
//   CAPTURED         paid to the supplier; Undo now refunds
//   VOIDED / REFUNDED / REJECTED / FAILED

const { evaluate, round2, eur } = require('./policy');

function isVaultRefusal(e) {
  const text = `${e.message} ${JSON.stringify((e.body && e.body.details) || '')}`;
  return /NOT_ENABLED_TO_VAULT|PAYEE_NOT_ENABLED_FOR_VAULT|VAULT_NOT_ENABLED|PAYMENT_SOURCE_CANNOT_BE_USED|INVALID_VAULT_ID|PAYER_ACTION_REQUIRED/i.test(text);
}

class Orders {
  constructor({ store, paypal, baseUrl }) {
    this.store = store;
    this.paypal = paypal;
    this.baseUrl = baseUrl;
  }

  get state() {
    return this.store.state;
  }

  // One action per order at a time, so a double-click cannot void twice,
  // or approve and undo at the same moment.
  async lock(id, fn) {
    this.busy = this.busy || new Set();
    if (this.busy.has(id)) throw new Error(`${id} is already being updated. Try again in a moment.`);
    this.busy.add(id);
    try {
      return await fn();
    } finally {
      this.busy.delete(id);
    }
  }

  create(v, input, actor) {
    const sup = this.store.supplier(v.supplierId);
    const agent = (this.state.agents || []).find((a) => a.id === v.agentId);
    actor = actor || (agent ? agent.name : 'Agent');
    const status = v.decision === 'blocked' ? 'BLOCKED' : v.decision === 'auto' ? 'PAYING' : 'NEEDS_APPROVAL';
    const order = {
      id: this.store.nextId('PO'),
      createdAt: new Date().toISOString(),
      createdBy: actor,
      agentId: v.agentId,
      checks: v.checks,
      receipt: v.receipt,
      supplierId: v.supplierId,
      supplierName: sup ? sup.name : 'Unknown supplier',
      lines: v.lines,
      total: v.total,
      currency: v.currency,
      note: input.note || '',
      decision: v.decision,
      reasons: v.reasons,
      status,
      paypal: {},
      undoUntil: null,
      approveUrl: null,
      error: null,
    };
    this.state.orders.unshift(order);
    const label = { BLOCKED: 'blocked by your rules', PAYING: 'within your rules, paying now', NEEDS_APPROVAL: 'waiting for your OK' }[status];
    this.store.audit(actor, 'order.proposed', `${order.supplierName}, ${eur(order.total)}: ${label}.`, order.id);
    this.store.save();
    return order;
  }

  async payAuto(order) {
    try {
      const r = await this.paypal.authorizeWithVault({ vaultId: this.state.mandate.vaultId, order, catalogue: this.state.catalogue });
      this.authorized(order, r, order.createdBy);
    } catch (e) {
      if (isVaultRefusal(e)) {
        // PayPal will not charge the saved account (e.g. the merchant is not
        // enabled for vaulted payments). Fall back to buyer approval rather
        // than failing the order, and stop trying the vault until it is fixed.
        this.state.mandate.vaultBlocked = true;
        order.status = 'NEEDS_APPROVAL';
        order.decision = 'needs_approval';
        const msg = 'PayPal refused to charge the saved account, so this order needs approval in PayPal.';
        order.reasons = [...order.reasons, { code: 'VAULT_REFUSED', severity: 'review', message: msg }];
        if (order.checks) order.checks = order.checks.map((c) => (c.code === 'NO_VAULT' ? { ...c, status: 'review', detail: msg } : c));
        this.store.audit('PayPal', 'vault.refused', `${order.supplierName}: PayPal asked for your approval instead of paying automatically.`, order.id);
        this.store.save();
      } else {
        this.fail(order, e);
      }
    }
    return order;
  }

  // Kill switch: pause every agent and void every authorization that is
  // still inside its undo window. Nothing already captured is touched.
  async killSwitch(actor) {
    const m = this.state.mandate;
    m.active = false;
    m.version = (m.version || 1) + 1;
    const open = this.state.orders.filter((o) => o.status === 'AUTHORIZED');
    let voided = 0;
    for (const o of open) {
      try {
        await this.lock(o.id, () => this.undo(o, actor, true));
        voided += 1;
      } catch (e) {
        this.store.audit('PayPal', 'payment.void_failed', `${o.id}: ${e.message}`, o.id);
      }
    }
    this.store.audit(actor, 'mandate.killed', `Stopped all agents${voided ? ` and cancelled ${voided} payment${voided > 1 ? 's' : ''} on hold` : ''}.`);
    this.store.save();
    return { voided };
  }

  // Applies a verified PayPal webhook to the matching order.
  reconcile(event) {
    const r = event.resource || {};
    const ids = [r.id, r.custom_id, r.invoice_id && r.invoice_id.split('-').slice(0, 2).join('-'),
      r.supplementary_data && r.supplementary_data.related_ids && r.supplementary_data.related_ids.authorization_id].filter(Boolean);
    if (!ids.length) return null;
    const order = this.state.orders.find((o) => [o.id, o.paypal.authorizationId, o.paypal.captureId].filter(Boolean).some((x) => ids.includes(x)));
    if (!order) return null;
    const map = {
      'PAYMENT.AUTHORIZATION.VOIDED': 'VOIDED',
      'PAYMENT.CAPTURE.COMPLETED': 'CAPTURED',
      'PAYMENT.CAPTURE.REFUNDED': 'REFUNDED',
      'PAYMENT.CAPTURE.DENIED': 'FAILED',
    };
    const next = map[event.event_type];
    if (next && order.status !== next) {
      this.store.audit('PayPal webhook', 'webhook.applied', `${order.supplierName}: PayPal confirmed ${event.event_type.toLowerCase().replace(/^payment\./, '').replace(/[._]/g, ' ')}.`, order.id);
      order.status = next;
      if (next !== 'CAPTURED') order.undoUntil = null;
      this.store.save();
    }
    return order;
  }

  authorized(order, r, actor) {
    order.paypal.orderId = r.paypalOrderId || order.paypal.orderId;
    order.paypal.authorizationId = r.authorizationId;
    order.status = 'AUTHORIZED';
    order.undoUntil = new Date(Date.now() + this.state.mandate.undoWindowSec * 1000).toISOString();
    order.approveUrl = null;
    this.store.audit(actor, 'payment.authorized', `${order.supplierName}, ${eur(order.total)}: paid and on hold in PayPal. Can be undone for ${this.state.mandate.undoWindowSec} seconds.`, order.id);
    this.store.save();
  }

  fail(order, e) {
    order.status = 'FAILED';
    order.error = e.message;
    this.store.audit('PayPal', 'payment.failed', `${order.supplierName}: payment failed. ${e.message}`, order.id);
    this.store.save();
  }

  // Human approval re-checks the hard limits at the moment of approval, so
  // a stale proposal cannot push spend past the caps.
  async startApproval(order) {
    if (order.status !== 'NEEDS_APPROVAL') throw new Error(`${order.id} is ${order.status}, not waiting for approval.`);
    const others = this.state.orders.filter((o) => o.id !== order.id);
    const v = evaluate({ ...this.state, orders: others }, { agentId: order.agentId, lines: order.lines.map((l) => ({ sku: l.sku, qty: l.qty })) });
    const hard = v.reasons.filter((r) => r.severity === 'block');
    if (hard.length) throw new Error(`Cannot approve: ${hard.map((r) => r.message).join(' ')}`);
    const r = await this.paypal.createApprovalOrder({
      order,
      catalogue: this.state.catalogue,
      returnUrl: `${this.baseUrl}/paypal/order/return?ref=${order.id}`,
      cancelUrl: `${this.baseUrl}/paypal/order/cancel?ref=${order.id}`,
    });
    order.paypal.orderId = r.paypalOrderId;
    order.approveUrl = r.approveUrl;
    this.store.audit(this.state.company.buyer, 'approval.started', `${order.supplierName}, ${eur(order.total)}: opened PayPal to approve.`, order.id);
    this.store.save();
    return r.approveUrl;
  }

  async completeApproval(orderId) {
    const order = this.store.order(orderId);
    if (!order) throw new Error(`Unknown order ${orderId}`);
    if (order.status !== 'NEEDS_APPROVAL') return order;
    order.status = 'PAYING';
    this.store.save();
    try {
      const r = await this.paypal.authorizeApprovedOrder(order.paypal.orderId);
      this.authorized(order, r, this.state.company.buyer);
    } catch (e) {
      this.fail(order, e);
    }
    return order;
  }

  cancelApproval(orderId) {
    const order = this.store.order(orderId);
    if (order && order.status === 'NEEDS_APPROVAL') {
      order.approveUrl = null;
      this.store.audit(this.state.company.buyer, 'approval.cancelled', `${order.supplierName}: approval cancelled. Still waiting for you.`, order.id);
      this.store.save();
    }
  }

  reject(order) {
    if (order.status !== 'NEEDS_APPROVAL') throw new Error(`${order.id} is ${order.status}; only orders waiting for approval can be rejected.`);
    order.status = 'REJECTED';
    order.approveUrl = null;
    this.store.audit(this.state.company.buyer, 'order.rejected', `${order.supplierName}, ${eur(order.total)}: declined. Nothing was charged.`, order.id);
    this.store.save();
    return order;
  }

  async undo(order, actor, quiet) {
    if (order.status === 'AUTHORIZED') {
      await this.paypal.voidAuthorization(order.paypal.authorizationId);
      order.status = 'VOIDED';
      order.undoUntil = null;
      this.store.audit(actor, 'payment.voided', `${order.supplierName}, ${eur(order.total)}: undone. PayPal cancelled the hold, no money moved.`, order.id);
    } else if (order.status === 'CAPTURED') {
      const r = await this.paypal.refundCapture(order.paypal.captureId, order);
      order.status = 'REFUNDED';
      order.paypal.refundId = r.refundId;
      this.receive(order, -1);
      this.store.audit(actor, 'payment.refunded', `${order.supplierName}, ${eur(order.total)}: refunded through PayPal.`, order.id);
    } else {
      throw new Error(`${order.id} is ${order.status} and cannot be undone.`);
    }
    if (!quiet) this.store.save();
    return order;
  }

  receive(order, sign) {
    for (const l of order.lines) {
      const inv = this.state.inventory.find((i) => i.sku === l.sku);
      if (inv) inv.onHand = Math.max(0, inv.onHand + sign * l.qty);
      if (sign > 0) this.state.priceHistory[l.sku] = l.unitPrice;
    }
  }

  // Captures authorizations whose undo window has closed.
  async sweep(now = Date.now()) {
    const busy = this.busy || new Set();
    const due = this.state.orders.filter((o) => o.status === 'AUTHORIZED' && !busy.has(o.id) && new Date(o.undoUntil).getTime() <= now);
    for (const order of due) {
      busy.add(order.id);
      this.busy = busy;
      try {
        order.status = 'CAPTURING';
        const r = await this.paypal.captureAuthorization(order.paypal.authorizationId, order);
        order.status = 'CAPTURED';
        order.paypal.captureId = r.captureId;
        order.undoUntil = null;
        // Demo shortcut: treat the stock as received on capture so the
        // agent sees the new cover on its next run.
        this.receive(order, 1);
        this.store.audit('PayPal', 'payment.captured', `${order.supplierName}, ${eur(order.total)}: undo window closed, payment completed.`, order.id);
      } catch (e) {
        order.status = 'AUTHORIZED';
        order.error = e.message;
        this.store.audit('PayPal', 'payment.capture_failed', `${order.supplierName}: payment failed. ${e.message}`, order.id);
      } finally {
        busy.delete(order.id);
      }
      this.store.save();
    }
    return due.length;
  }

  totals() {
    const sum = (s) => round2(this.state.orders.filter((o) => s.includes(o.status)).reduce((a, o) => a + o.total, 0));
    return { held: sum(['PAYING', 'AUTHORIZED', 'CAPTURING']), paid: sum(['CAPTURED']), waiting: sum(['NEEDS_APPROVAL']) };
  }
}

module.exports = { Orders };
