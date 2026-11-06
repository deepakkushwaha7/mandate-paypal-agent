// Order lifecycle. Every state change is written to the audit log.
//
//   BLOCKED          mandate engine refused it; nothing sent to PayPal
//   NEEDS_APPROVAL   waiting for a human to approve in PayPal
//   PAYING           authorization in flight
//   AUTHORIZED       funds held; buyer can Undo (void) until undoUntil
//   CAPTURED         paid to the supplier; Undo now refunds
//   VOIDED / REFUNDED / REJECTED / FAILED

const { evaluate, round2 } = require('./policy');

class Orders {
  constructor({ store, paypal, baseUrl }) {
    this.store = store;
    this.paypal = paypal;
    this.baseUrl = baseUrl;
  }

  get state() {
    return this.store.state;
  }

  create(v, input, actor = 'Agent') {
    const sup = this.store.supplier(v.supplierId);
    const status = v.decision === 'blocked' ? 'BLOCKED' : v.decision === 'auto' ? 'PAYING' : 'NEEDS_APPROVAL';
    const order = {
      id: this.store.nextId('PO'),
      createdAt: new Date().toISOString(),
      createdBy: actor,
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
    const label = { BLOCKED: 'blocked by the mandate', PAYING: 'within mandate, paying automatically', NEEDS_APPROVAL: 'needs human approval' }[status];
    this.store.audit(actor, 'order.proposed', `${order.id} to ${order.supplierName}, €${order.total.toFixed(2)}: ${label}.`, order.id);
    this.store.save();
    return order;
  }

  async payAuto(order) {
    try {
      const r = await this.paypal.authorizeWithVault({ vaultId: this.state.mandate.vaultId, order, catalogue: this.state.catalogue });
      this.authorized(order, r, 'Agent');
    } catch (e) {
      this.fail(order, e);
    }
    return order;
  }

  authorized(order, r, actor) {
    order.paypal.orderId = r.paypalOrderId || order.paypal.orderId;
    order.paypal.authorizationId = r.authorizationId;
    order.status = 'AUTHORIZED';
    order.undoUntil = new Date(Date.now() + this.state.mandate.undoWindowSec * 1000).toISOString();
    order.approveUrl = null;
    this.store.audit(actor, 'payment.authorized', `${order.id}: PayPal authorization ${r.authorizationId} for €${order.total.toFixed(2)}. Undo open for ${this.state.mandate.undoWindowSec}s.`, order.id);
    this.store.save();
  }

  fail(order, e) {
    order.status = 'FAILED';
    order.error = e.message;
    this.store.audit('PayPal', 'payment.failed', `${order.id}: ${e.message}`, order.id);
    this.store.save();
  }

  // Human approval re-checks the hard limits at the moment of approval, so
  // a stale proposal cannot push spend past the caps.
  async startApproval(order) {
    if (order.status !== 'NEEDS_APPROVAL') throw new Error(`${order.id} is ${order.status}, not waiting for approval.`);
    const others = this.state.orders.filter((o) => o.id !== order.id);
    const v = evaluate({ ...this.state, orders: others }, { lines: order.lines.map((l) => ({ sku: l.sku, qty: l.qty })) });
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
    this.store.audit(this.state.company.buyer, 'approval.started', `${order.id}: sent to PayPal for approval.`, order.id);
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
      this.store.audit(this.state.company.buyer, 'approval.cancelled', `${order.id}: approval cancelled in PayPal. Still waiting.`, order.id);
      this.store.save();
    }
  }

  reject(order) {
    if (order.status !== 'NEEDS_APPROVAL') throw new Error(`${order.id} is ${order.status}; only orders waiting for approval can be rejected.`);
    order.status = 'REJECTED';
    order.approveUrl = null;
    this.store.audit(this.state.company.buyer, 'order.rejected', `${order.id} rejected.`, order.id);
    this.store.save();
    return order;
  }

  async undo(order, actor) {
    if (order.status === 'AUTHORIZED') {
      await this.paypal.voidAuthorization(order.paypal.authorizationId);
      order.status = 'VOIDED';
      order.undoUntil = null;
      this.store.audit(actor, 'payment.voided', `${order.id}: undone. PayPal authorization ${order.paypal.authorizationId} voided, no money moved.`, order.id);
    } else if (order.status === 'CAPTURED') {
      const r = await this.paypal.refundCapture(order.paypal.captureId, order);
      order.status = 'REFUNDED';
      order.paypal.refundId = r.refundId;
      this.receive(order, -1);
      this.store.audit(actor, 'payment.refunded', `${order.id}: undone after capture. Refund ${r.refundId} for €${order.total.toFixed(2)}.`, order.id);
    } else {
      throw new Error(`${order.id} is ${order.status} and cannot be undone.`);
    }
    this.store.save();
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
    const due = this.state.orders.filter((o) => o.status === 'AUTHORIZED' && new Date(o.undoUntil).getTime() <= now);
    for (const order of due) {
      try {
        order.status = 'CAPTURING';
        const r = await this.paypal.captureAuthorization(order.paypal.authorizationId, order);
        order.status = 'CAPTURED';
        order.paypal.captureId = r.captureId;
        order.undoUntil = null;
        // Demo shortcut: treat the stock as received on capture so the
        // agent sees the new cover on its next run.
        this.receive(order, 1);
        this.store.audit('PayPal', 'payment.captured', `${order.id}: captured ${r.captureId}, €${order.total.toFixed(2)} paid to ${order.supplierName}.`, order.id);
      } catch (e) {
        order.status = 'AUTHORIZED';
        order.error = e.message;
        this.store.audit('PayPal', 'payment.capture_failed', `${order.id}: ${e.message}`, order.id);
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
