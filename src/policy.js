// The mandate engine. Deterministic code, not the model, decides whether an
// agent proposal may be paid automatically, needs a human, or is blocked.
// The agent only proposes SKUs and quantities; prices always come from the
// catalogue, so the model cannot talk its way into a different total.

const COUNTED = new Set(['PAYING', 'AUTHORIZED', 'CAPTURING', 'CAPTURED']);

function round2(n) {
  return Math.round(n * 100) / 100;
}

function monthKey(iso) {
  return iso.slice(0, 7);
}

function spentThisMonth(state, now = new Date()) {
  const key = monthKey(now.toISOString());
  const fromOrders = state.orders
    .filter((o) => COUNTED.has(o.status) && monthKey(o.createdAt) === key)
    .reduce((s, o) => s + o.total, 0);
  return round2((state.mandate.openingSpend || 0) + fromOrders);
}

// Price a proposal from the catalogue and normalise quantities.
function price(state, lines) {
  const priced = [];
  const problems = [];
  for (const line of lines || []) {
    const item = state.catalogue.find((c) => c.sku === line.sku);
    if (!item) {
      problems.push({ code: 'UNKNOWN_SKU', severity: 'block', message: `SKU ${line.sku} is not in the catalogue.` });
      continue;
    }
    const qty = Math.floor(Number(line.qty));
    if (!Number.isFinite(qty) || qty <= 0) {
      problems.push({ code: 'BAD_QTY', severity: 'block', message: `${item.sku}: quantity must be a positive whole number.` });
      continue;
    }
    priced.push({
      sku: item.sku,
      name: item.name,
      category: item.category,
      supplierId: item.supplierId,
      qty,
      unitPrice: item.unitPrice,
      lineTotal: round2(qty * item.unitPrice),
      reason: line.reason || '',
    });
  }
  const total = round2(priced.reduce((s, l) => s + l.lineTotal, 0));
  return { lines: priced, total, problems };
}

function evaluate(state, proposal, opts = {}) {
  const now = opts.now || new Date();
  const m = state.mandate;
  const { lines, total, problems } = price(state, proposal.lines);
  const reasons = [...problems];

  if (!m.active) reasons.push({ code: 'MANDATE_PAUSED', severity: 'block', message: 'The mandate is paused. The agent cannot spend.' });
  if (lines.length === 0) reasons.push({ code: 'EMPTY', severity: 'block', message: 'The proposal has no valid lines.' });

  const suppliers = new Set(lines.map((l) => l.supplierId));
  if (suppliers.size > 1) {
    reasons.push({ code: 'MULTI_SUPPLIER', severity: 'block', message: 'One order may only contain one supplier. Split the proposal per supplier.' });
  }

  for (const l of lines) {
    const item = state.catalogue.find((c) => c.sku === l.sku);
    if (!m.allowedSupplierIds.includes(l.supplierId)) {
      const sup = state.suppliers.find((s) => s.id === l.supplierId);
      reasons.push({ code: 'SUPPLIER_NOT_ALLOWED', severity: 'block', message: `${l.sku}: supplier ${sup ? sup.name : l.supplierId} is outside the mandate.` });
    }
    if (!m.allowedCategories.includes(l.category)) {
      reasons.push({ code: 'CATEGORY_NOT_ALLOWED', severity: 'block', message: `${l.sku}: category "${l.category}" is outside the mandate.` });
    }
    if (l.qty < item.moq) {
      reasons.push({ code: 'BELOW_MOQ', severity: 'block', message: `${l.sku}: ${l.qty} is below the supplier minimum of ${item.moq}.` });
    }
    if (l.qty % item.packSize !== 0) {
      reasons.push({ code: 'PACK_SIZE', severity: 'block', message: `${l.sku}: quantity must be a multiple of ${item.packSize}.` });
    }
    const last = state.priceHistory[l.sku];
    if (last && l.unitPrice > last) {
      const pct = ((l.unitPrice - last) / last) * 100;
      if (pct > m.maxPriceIncreasePct) {
        reasons.push({ code: 'PRICE_DRIFT', severity: 'review', message: `${l.sku}: unit price rose ${pct.toFixed(1)}% since the last order (€${last} → €${l.unitPrice}). Limit is ${m.maxPriceIncreasePct}%.` });
      }
    }
    const recent = state.orders.find(
      (o) => ['AUTHORIZED', 'CAPTURED', 'NEEDS_APPROVAL'].includes(o.status) &&
        now - new Date(o.createdAt) < 48 * 3600000 &&
        o.lines.some((x) => x.sku === l.sku)
    );
    if (recent) {
      reasons.push({ code: 'DUPLICATE', severity: 'review', message: `${l.sku} was already ordered in ${recent.id} within the last 48 hours.` });
    }
  }

  const spent = spentThisMonth(state, now);
  const remaining = round2(m.monthlyCap - spent);
  if (total > m.perOrderCap) {
    reasons.push({ code: 'PER_ORDER_CAP', severity: 'block', message: `Order total €${total.toFixed(2)} exceeds the per-order cap of €${m.perOrderCap}.` });
  }
  if (total > remaining) {
    reasons.push({ code: 'MONTHLY_CAP', severity: 'block', message: `Order total €${total.toFixed(2)} exceeds the €${remaining.toFixed(2)} left this month.` });
  }
  if (total >= m.autoApproveBelow) {
    reasons.push({ code: 'ABOVE_AUTO', severity: 'review', message: `Order total €${total.toFixed(2)} is at or above the auto-pay limit of €${m.autoApproveBelow}.` });
  }
  if (!m.vaultId) {
    reasons.push({ code: 'NO_VAULT', severity: 'review', message: 'No saved PayPal payment method yet, so a human must approve in PayPal.' });
  }

  let decision = 'auto';
  if (reasons.some((r) => r.severity === 'block')) decision = 'blocked';
  else if (reasons.some((r) => r.severity === 'review')) decision = 'needs_approval';

  return {
    decision,
    reasons,
    lines,
    total,
    currency: m.currency,
    supplierId: lines[0] ? lines[0].supplierId : null,
    budget: { monthlyCap: m.monthlyCap, spent, remaining, afterOrder: round2(remaining - total) },
  };
}

module.exports = { evaluate, price, spentThisMonth, round2 };
