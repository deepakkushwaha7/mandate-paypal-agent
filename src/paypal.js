// PayPal client. Two implementations share one interface:
//   - PayPalRest talks to the PayPal REST APIs (sandbox or live).
//   - PayPalSimulator mimics the same flows in memory so the app runs
//     with no credentials (tests, offline demos).
//
// Flows used:
//   Mandate setup  : Vault v3 setup token -> buyer approves -> payment token
//   Agent payment  : Orders v2, intent AUTHORIZE, payment_source.paypal.vault_id
//   Human approval : Orders v2, intent AUTHORIZE, buyer approves -> authorize
//   Settle         : Payments v2 capture authorization
//   Undo           : Payments v2 void authorization, or refund capture

const crypto = require('crypto');

function money(n) {
  return (Math.round(n * 100) / 100).toFixed(2);
}

// PayPal amounts allow two decimals, but some packaging items cost
// fractions of a cent per unit. Lines are sent per supplier pack instead
// (e.g. 3 x "1,000-pack" at €45.00), which keeps every amount exact.
function purchaseUnit(order, catalogue) {
  const items = order.lines.map((l) => {
    const item = catalogue.find((c) => c.sku === l.sku);
    const pack = item ? item.packSize : 1;
    const packs = Math.round(l.qty / pack);
    return {
      name: `${l.name} (${pack.toLocaleString('en')}-pack)`.slice(0, 127),
      sku: l.sku,
      quantity: String(packs),
      unit_amount: { currency_code: order.currency, value: money(l.unitPrice * pack) },
      category: 'PHYSICAL_GOODS',
    };
  });
  const itemTotal = items.reduce((s, i) => s + Number(i.unit_amount.value) * Number(i.quantity), 0);
  return {
    reference_id: order.id,
    invoice_id: `${order.id}-${Date.now()}`,
    description: `Agent reorder ${order.id} for ${order.supplierName}`.slice(0, 127),
    custom_id: order.id,
    soft_descriptor: 'MANDATE',
    amount: {
      currency_code: order.currency,
      value: money(itemTotal),
      breakdown: { item_total: { currency_code: order.currency, value: money(itemTotal) } },
    },
    items,
  };
}

class PayPalRest {
  constructor({ clientId, clientSecret, env = 'sandbox', brandName = 'Mandate' }) {
    this.mode = env === 'live' ? 'live' : 'sandbox';
    this.base = this.mode === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.brandName = brandName;
    this.token = null;
    this.tokenExpires = 0;
  }

  async accessToken() {
    if (this.token && Date.now() < this.tokenExpires - 60000) return this.token;
    const res = await fetch(`${this.base}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
    const body = await res.json();
    if (!res.ok) throw new PayPalError('Could not get a PayPal access token. Check PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET.', res.status, body);
    this.token = body.access_token;
    this.tokenExpires = Date.now() + body.expires_in * 1000;
    return this.token;
  }

  async call(method, path, body, requestId) {
    const headers = {
      Authorization: `Bearer ${await this.accessToken()}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    };
    if (requestId) headers['PayPal-Request-Id'] = requestId;
    const res = await fetch(`${this.base}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) {
      const detail = json.details && json.details[0] ? `${json.details[0].issue}: ${json.details[0].description}` : json.message || res.statusText;
      throw new PayPalError(`PayPal ${method} ${path} failed (${res.status}): ${detail}`, res.status, json);
    }
    return json;
  }

  async createVaultSetup({ returnUrl, cancelUrl }) {
    const body = {
      payment_source: {
        paypal: {
          description: 'Lets the purchasing agent pay suppliers within your mandate.',
          usage_pattern: 'IMMEDIATE',
          usage_type: 'MERCHANT',
          customer_type: 'CONSUMER',
          experience_context: {
            brand_name: this.brandName,
            shipping_preference: 'NO_SHIPPING',
            return_url: returnUrl,
            cancel_url: cancelUrl,
          },
        },
      },
    };
    const r = await this.call('POST', '/v3/vault/setup-tokens', body, crypto.randomUUID());
    const approve = (r.links || []).find((l) => l.rel === 'approve');
    return { setupTokenId: r.id, approveUrl: approve && approve.href };
  }

  async createPaymentToken(setupTokenId) {
    const r = await this.call('POST', '/v3/vault/payment-tokens', {
      payment_source: { token: { id: setupTokenId, type: 'SETUP_TOKEN' } },
    }, crypto.randomUUID());
    const paypal = (r.payment_source && r.payment_source.paypal) || {};
    return { vaultId: r.id, label: paypal.email_address || 'PayPal account' };
  }

  async authorizeWithVault({ vaultId, order, catalogue }) {
    const r = await this.call('POST', '/v2/checkout/orders', {
      intent: 'AUTHORIZE',
      purchase_units: [purchaseUnit(order, catalogue)],
      payment_source: { paypal: { vault_id: vaultId } },
    }, `auth-${order.id}`);
    const auth = r.purchase_units && r.purchase_units[0].payments && r.purchase_units[0].payments.authorizations && r.purchase_units[0].payments.authorizations[0];
    if (!auth) throw new PayPalError(`PayPal returned order ${r.id} with status ${r.status} but no authorization.`, 422, r);
    return { paypalOrderId: r.id, authorizationId: auth.id, status: auth.status, expiresAt: auth.expiration_time || null };
  }

  async createApprovalOrder({ order, catalogue, returnUrl, cancelUrl }) {
    const r = await this.call('POST', '/v2/checkout/orders', {
      intent: 'AUTHORIZE',
      purchase_units: [purchaseUnit(order, catalogue)],
      payment_source: {
        paypal: {
          experience_context: {
            brand_name: this.brandName,
            shipping_preference: 'NO_SHIPPING',
            user_action: 'CONTINUE',
            return_url: returnUrl,
            cancel_url: cancelUrl,
          },
        },
      },
    }, `approval-${order.id}`);
    const approve = (r.links || []).find((l) => l.rel === 'payer-action' || l.rel === 'approve');
    return { paypalOrderId: r.id, approveUrl: approve && approve.href };
  }

  async authorizeApprovedOrder(paypalOrderId) {
    const r = await this.call('POST', `/v2/checkout/orders/${paypalOrderId}/authorize`, {}, `authorize-${paypalOrderId}`);
    const auth = r.purchase_units[0].payments.authorizations[0];
    return { authorizationId: auth.id, status: auth.status, expiresAt: auth.expiration_time || null };
  }

  async captureAuthorization(authorizationId, order) {
    const r = await this.call('POST', `/v2/payments/authorizations/${authorizationId}/capture`, {
      final_capture: true,
      invoice_id: `${order.id}-cap`,
      note_to_payer: `Supplier order ${order.id}`,
    }, `capture-${authorizationId}`);
    return { captureId: r.id, status: r.status };
  }

  async voidAuthorization(authorizationId) {
    await this.call('POST', `/v2/payments/authorizations/${authorizationId}/void`, null, `void-${authorizationId}`);
    return { status: 'VOIDED' };
  }

  // Verifies a webhook with PayPal before the app trusts it.
  async verifyWebhook(headers, event) {
    const webhookId = process.env.PAYPAL_WEBHOOK_ID;
    if (!webhookId) return false;
    const r = await this.call('POST', '/v1/notifications/verify-webhook-signature', {
      auth_algo: headers['paypal-auth-algo'],
      cert_url: headers['paypal-cert-url'],
      transmission_id: headers['paypal-transmission-id'],
      transmission_sig: headers['paypal-transmission-sig'],
      transmission_time: headers['paypal-transmission-time'],
      webhook_id: webhookId,
      webhook_event: event,
    });
    return r.verification_status === 'SUCCESS';
  }

  async refundCapture(captureId, order) {
    const r = await this.call('POST', `/v2/payments/captures/${captureId}/refund`, {
      note_to_payer: `Undo of agent order ${order.id}`,
    }, `refund-${captureId}`);
    return { refundId: r.id, status: r.status };
  }
}

class PayPalSimulator {
  constructor({ baseUrl }) {
    this.mode = 'simulated';
    this.baseUrl = baseUrl;
    this.setupTokens = new Map();
    this.orders = new Map();
    this.authorizations = new Map();
    this.captures = new Map();
    this.calls = [];
  }

  id(prefix) {
    return `${prefix}${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
  }

  log(op, data) {
    this.calls.push({ op, at: new Date().toISOString(), ...data });
  }

  async createVaultSetup({ returnUrl, cancelUrl }) {
    const id = this.id('SETUP-');
    this.setupTokens.set(id, { status: 'PAYER_ACTION_REQUIRED' });
    this.log('vault.setup', { id });
    const q = new URLSearchParams({ kind: 'vault', token: id, return: returnUrl, cancel: cancelUrl });
    return { setupTokenId: id, approveUrl: `${this.baseUrl}/simulated-paypal/approve?${q}` };
  }

  markApproved(token) {
    if (this.setupTokens.has(token)) this.setupTokens.get(token).status = 'APPROVED';
    if (this.orders.has(token)) this.orders.get(token).status = 'APPROVED';
  }

  async createPaymentToken(setupTokenId) {
    const st = this.setupTokens.get(setupTokenId);
    if (!st || st.status !== 'APPROVED') throw new PayPalError('Setup token was not approved by the payer.', 422, {});
    const vaultId = this.id('VAULT-');
    this.log('vault.payment_token', { vaultId });
    return { vaultId, label: 'buyer-sandbox@northwind.example' };
  }

  async verifyWebhook() {
    return false;
  }

  async authorizeWithVault({ vaultId, order, catalogue }) {
    if (!vaultId) throw new PayPalError('vault_id is required', 422, {});
    if (this.refuseVault) throw new PayPalError('PayPal POST /v2/checkout/orders failed (422): NOT_ENABLED_TO_VAULT_PAYMENT_SOURCE: The merchant is not enabled to vault this payment source.', 422, {});
    const pu = purchaseUnit(order, catalogue);
    const orderId = this.id('ORD-');
    const authorizationId = this.id('AUTH-');
    this.authorizations.set(authorizationId, { status: 'CREATED', amount: pu.amount.value });
    this.log('orders.create+authorize', { orderId, authorizationId, amount: pu.amount.value });
    return { paypalOrderId: orderId, authorizationId, status: 'CREATED', expiresAt: null };
  }

  async createApprovalOrder({ order, catalogue, returnUrl, cancelUrl }) {
    const pu = purchaseUnit(order, catalogue);
    const id = this.id('ORD-');
    this.orders.set(id, { status: 'PAYER_ACTION_REQUIRED', amount: pu.amount.value });
    this.log('orders.create', { id, amount: pu.amount.value });
    const q = new URLSearchParams({ kind: 'order', token: id, amount: pu.amount.value, currency: order.currency, return: returnUrl, cancel: cancelUrl });
    return { paypalOrderId: id, approveUrl: `${this.baseUrl}/simulated-paypal/approve?${q}` };
  }

  async authorizeApprovedOrder(paypalOrderId) {
    const o = this.orders.get(paypalOrderId);
    if (!o || o.status !== 'APPROVED') throw new PayPalError('Order was not approved by the payer.', 422, {});
    const authorizationId = this.id('AUTH-');
    this.authorizations.set(authorizationId, { status: 'CREATED', amount: o.amount });
    this.log('orders.authorize', { paypalOrderId, authorizationId });
    return { authorizationId, status: 'CREATED', expiresAt: null };
  }

  async captureAuthorization(authorizationId) {
    const a = this.authorizations.get(authorizationId);
    if (!a || a.status !== 'CREATED') throw new PayPalError(`Authorization ${authorizationId} cannot be captured.`, 422, {});
    a.status = 'CAPTURED';
    const captureId = this.id('CAP-');
    this.captures.set(captureId, { status: 'COMPLETED' });
    this.log('authorizations.capture', { authorizationId, captureId });
    return { captureId, status: 'COMPLETED' };
  }

  async voidAuthorization(authorizationId) {
    const a = this.authorizations.get(authorizationId);
    if (!a || a.status !== 'CREATED') throw new PayPalError(`Authorization ${authorizationId} cannot be voided.`, 422, {});
    a.status = 'VOIDED';
    this.log('authorizations.void', { authorizationId });
    return { status: 'VOIDED' };
  }

  async refundCapture(captureId) {
    const c = this.captures.get(captureId);
    if (!c || c.status !== 'COMPLETED') throw new PayPalError(`Capture ${captureId} cannot be refunded.`, 422, {});
    c.status = 'REFUNDED';
    const refundId = this.id('REF-');
    this.log('captures.refund', { captureId, refundId });
    return { refundId, status: 'COMPLETED' };
  }
}

class PayPalError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

function createPayPal({ baseUrl }) {
  const { PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_ENV } = process.env;
  if (PAYPAL_CLIENT_ID && PAYPAL_CLIENT_SECRET) {
    return new PayPalRest({ clientId: PAYPAL_CLIENT_ID, clientSecret: PAYPAL_CLIENT_SECRET, env: PAYPAL_ENV || 'sandbox' });
  }
  return new PayPalSimulator({ baseUrl });
}

module.exports = { createPayPal, PayPalRest, PayPalSimulator, PayPalError, purchaseUnit };
