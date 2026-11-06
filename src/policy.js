// The mandate engine. Deterministic code, not the model, decides whether an
// agent proposal may be paid automatically, needs a human, or is blocked.
//
// - The agent only proposes SKUs and quantities. Prices always come from the
//   catalogue, so a model cannot talk its way into a different total.
// - Every evaluation returns a receipt: each rule that was checked, its
//   result, the mandate version and the agent's own reason. That answers
//   "why was this allowed?", not only "what happened?".
// - The auto-pay limit applies to the rolling 24-hour total per supplier, so
//   an agent cannot slip under it by splitting one purchase into several.

const COUNTED = new Set(['PAYING', 'AUTHORIZED', 'CAPTURING', 'CAPTURED']);
const AUTO_PAID = new Set(['PAYING', 'AUTHORIZED', 'CAPTURING', 'CAPTURED']);
const DAY = 24 * 3600000;
const nm = (l) => String(l.name || l.sku).split(',')[0];

function round2(n) {
  return Math.round(n * 100) / 100;
}

const eur = (n) => `€${Number(n).toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function monthKey(iso) {
  return iso.slice(0, 7);
}

function spentThisMonth(state, now = new Date(), agentId = null) {
  const key = monthKey(now.toISOString());
  const fromOrders = state.orders
    .filter((o) => COUNTED.has(o.status) && monthKey(o.createdAt) === key && (!agentId || o.agentId === agentId))
    .reduce((s, o) => s + o.total, 0);
  return round2((agentId ? 0 : state.mandate.openingSpend || 0) + fromOrders);
}

// Price a proposal from the catalogue and normalise quantities.
function price(state, lines) {
  const priced = [];
  const problems = [];
  for (const line of lines || []) {
    const item = state.catalogue.find((c) => c.sku === line.sku);
    if (!item) {
      problems.push(`${line.sku || 'An item'} is not in the catalogue.`);
      continue;
    }
    const qty = Math.floor(Number(line.qty));
    if (!Number.isFinite(qty) || qty <= 0) {
      problems.push(`${item.sku}: quantity must be a positive whole number.`);
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
      reason: String(line.reason || '').slice(0, 300),
    });
  }
  const total = round2(priced.reduce((s, l) => s + l.lineTotal, 0));
  return { lines: priced, total, problems };
}

function evaluate(state, proposal, opts = {}) {
  const now = opts.now || new Date();
  const m = state.mandate;
  const agentId = proposal.agentId || 'reorder-agent';
  const agent = (state.agents || []).find((a) => a.id === agentId);
  const { lines, total, problems } = price(state, proposal.lines);
  const supName = (id) => (state.suppliers.find((s) => s.id === id) || {}).name || id;
  const checks = [];
  const add = (code, label, status, detail) => checks.push({ code, label, status, detail });

  // 1. Who is asking
  if (!agent) add('AGENT', 'Agent is allowed to spend', 'block', `Unknown agent "${agentId}".`);
  else if (!agent.active) add('AGENT', 'Agent is allowed to spend', 'block', `${agent.name} is paused.`);
  else add('AGENT', 'Agent is allowed to spend', 'pass', `${agent.name}.`);

  add('MANDATE_PAUSED', 'Rules are switched on', m.active ? 'pass' : 'block', m.active ? 'Agents may spend.' : 'All agents are stopped.');

  // 2. What is being bought
  if (problems.length || lines.length === 0) add('CATALOGUE', 'Items and prices from your catalogue', 'block', problems.join(' ') || 'The proposal has no valid lines.');
  else add('CATALOGUE', 'Items and prices from your catalogue', 'pass', 'Prices come from your catalogue, never from the agent.');

  const suppliers = [...new Set(lines.map((l) => l.supplierId))];
  if (suppliers.length > 1) add('MULTI_SUPPLIER', 'One supplier per order', 'block', 'Split the proposal per supplier.');
  else add('MULTI_SUPPLIER', 'One supplier per order', lines.length ? 'pass' : 'skip', lines.length ? supName(suppliers[0]) : '');

  const badSup = lines.filter((l) => !m.allowedSupplierIds.includes(l.supplierId));
  add('SUPPLIER_NOT_ALLOWED', 'Approved supplier', badSup.length ? 'block' : 'pass',
    badSup.length ? `${supName(badSup[0].supplierId)} is not on your approved list.` : 'On your approved list.');

  const badCat = lines.filter((l) => !m.allowedCategories.includes(l.category));
  add('CATEGORY_NOT_ALLOWED', 'Approved category', badCat.length ? 'block' : 'pass',
    badCat.length ? `${badCat[0].category[0].toUpperCase() + badCat[0].category.slice(1)} is not an approved category.` : [...new Set(lines.map((l) => l.category))].join(', '));

  const qtyIssues = [];
  for (const l of lines) {
    const item = state.catalogue.find((c) => c.sku === l.sku);
    if (l.qty < item.moq) qtyIssues.push(`${nm(l)}: ${l.qty.toLocaleString('en')} is below the supplier minimum of ${item.moq.toLocaleString('en')}.`);
    if (l.qty % item.packSize !== 0) qtyIssues.push(`${nm(l)}: must be ordered in packs of ${item.packSize.toLocaleString('en')}.`);
  }
  add('QUANTITY', 'Fits supplier minimums and pack sizes', qtyIssues.length ? 'block' : 'pass', qtyIssues.join(' ') || 'Meets minimums and pack sizes.');

  // 3. Is the price fair
  const drift = [];
  for (const l of lines) {
    const last = state.priceHistory[l.sku];
    if (last && l.unitPrice > last) {
      const pct = ((l.unitPrice - last) / last) * 100;
      if (pct > m.maxPriceIncreasePct) drift.push(`${nm(l)} went up ${pct.toFixed(1)}% since your last order (€${last} → €${l.unitPrice} each).`);
    }
  }
  add('PRICE_DRIFT', `No price rise over ${m.maxPriceIncreasePct}%`, drift.length ? 'review' : 'pass', drift.length ? `${drift.join(' ')} Your limit is ${m.maxPriceIncreasePct}%.` : 'Same price as last time, or within your limit.');

  const dupes = [];
  for (const l of lines) {
    const recent = state.orders.find((o) => ['PAYING', 'AUTHORIZED', 'CAPTURED', 'NEEDS_APPROVAL'].includes(o.status) &&
      now - new Date(o.createdAt) < 2 * DAY && o.lines.some((x) => x.sku === l.sku));
    if (recent) dupes.push(`${nm(l)} was already ordered (${recent.id}).`);
  }
  add('DUPLICATE', 'Not a repeat of a recent order', dupes.length ? 'review' : 'pass', dupes.join(' ') || 'No order for these items in the last 48 hours.');

  // 4. Money
  add('PER_ORDER_CAP', `Within the ${eur(m.perOrderCap)} order limit`, total > m.perOrderCap ? 'block' : 'pass', `${eur(total)} of ${eur(m.perOrderCap)}.`);

  const spent = spentThisMonth(state, now);
  const remaining = round2(m.monthlyCap - spent);
  add('MONTHLY_CAP', 'Within the monthly budget', total > remaining ? 'block' : 'pass', `${eur(total)} of ${eur(Math.max(0, remaining))} left this month.`);

  if (agent && agent.monthlyCap) {
    const agentSpent = spentThisMonth(state, now, agentId);
    const left = round2(agent.monthlyCap - agentSpent);
    add('AGENT_CAP', `Within ${agent.name}'s budget`, total > left ? 'block' : 'pass', `${eur(total)} of ${eur(Math.max(0, left))} left for this agent.`);
  }

  const supplierId = suppliers[0];
  const recentAuto = round2(state.orders
    .filter((o) => AUTO_PAID.has(o.status) && o.supplierId === supplierId && o.decision === 'auto' && now - new Date(o.createdAt) < DAY)
    .reduce((s, o) => s + o.total, 0));
  if (total >= m.autoApproveBelow) {
    add('ABOVE_AUTO', `Small enough to pay without asking (under ${eur(m.autoApproveBelow)})`, 'review', `${eur(total)} is over the limit, so it needs your OK.`);
  } else if (recentAuto > 0 && recentAuto + total >= m.autoApproveBelow) {
    add('SPLIT_ORDER', `Small enough to pay without asking (under ${eur(m.autoApproveBelow)})`, 'review',
      `${eur(total)} plus ${eur(recentAuto)} auto-paid to ${supName(supplierId)} in the last 24 hours reaches the limit. Split orders add up.`);
  } else {
    add('ABOVE_AUTO', `Small enough to pay without asking (under ${eur(m.autoApproveBelow)})`, lines.length ? 'pass' : 'skip',
      recentAuto ? `${eur(total)} plus ${eur(recentAuto)} earlier today.` : `${eur(total)}.`);
  }

  // 5. Can we pay without the buyer present
  if (m.vaultBlocked) add('NO_VAULT', 'PayPal saved for agents', 'review', 'PayPal asked for your approval on this payment.');
  else add('NO_VAULT', 'PayPal saved for agents', m.vaultId ? 'pass' : 'review', m.vaultId ? `${m.vaultLabel || 'PayPal account'}.` : 'PayPal is not saved yet, so you approve each payment.');

  let decision = 'auto';
  if (checks.some((c) => c.status === 'block')) decision = 'blocked';
  else if (checks.some((c) => c.status === 'review')) decision = 'needs_approval';

  const reasons = checks
    .filter((c) => c.status === 'block' || c.status === 'review')
    .map((c) => ({ code: c.code, severity: c.status, message: `${c.label}: ${c.detail}` }));

  return {
    decision,
    reasons,
    checks,
    lines,
    total,
    currency: m.currency,
    supplierId: supplierId || null,
    agentId,
    receipt: {
      mandateVersion: m.version || 1,
      evaluatedAt: now.toISOString(),
      agentId,
      agentName: agent ? agent.name : agentId,
      rationale: String(proposal.note || '').slice(0, 500),
    },
    budget: { monthlyCap: m.monthlyCap, spent, remaining, afterOrder: round2(remaining - total) },
  };
}

module.exports = { evaluate, price, spentThisMonth, round2, eur };

// Gate for any other money-moving action an agent wants to take through
// PayPal (for example a refund or an invoice via PayPal's Agent Toolkit).
// Same identity, budget and auto-pay rules as purchases.
function evaluateAction(state, { agentId, action, amount, note }, opts = {}) {
  const now = opts.now || new Date();
  const m = state.mandate;
  const agent = (state.agents || []).find((a) => a.id === agentId);
  const value = round2(Number(amount));
  const checks = [];
  const add = (code, label, status, detail) => checks.push({ code, label, status, detail });
  if (!agent) add('AGENT', 'Agent is allowed to spend', 'block', `Unknown agent "${agentId}".`);
  else add('AGENT', 'Agent is allowed to spend', agent.active ? 'pass' : 'block', agent.active ? `${agent.name}.` : `${agent.name} is paused.`);
  add('MANDATE_PAUSED', 'Rules are switched on', m.active ? 'pass' : 'block', m.active ? 'Agents may spend.' : 'All agents are stopped.');
  if (!Number.isFinite(value) || value <= 0) add('AMOUNT', 'Amount is valid', 'block', 'Amount must be a positive number.');
  else {
    add('PER_ORDER_CAP', `Within the ${eur(m.perOrderCap)} order limit`, value > m.perOrderCap ? 'block' : 'pass', `${eur(value)} of ${eur(m.perOrderCap)}.`);
    const remaining = round2(m.monthlyCap - spentThisMonth(state, now));
    add('MONTHLY_CAP', 'Within the monthly budget', value > remaining ? 'block' : 'pass', `${eur(value)} of ${eur(Math.max(0, remaining))} left this month.`);
    if (agent && agent.monthlyCap) {
      const left = round2(agent.monthlyCap - spentThisMonth(state, now, agentId));
      add('AGENT_CAP', `Within ${agent.name}'s budget`, value > left ? 'block' : 'pass', `${eur(value)} of ${eur(Math.max(0, left))} left for this agent.`);
    }
    add('ABOVE_AUTO', `Small enough to pay without asking (under ${eur(m.autoApproveBelow)})`, value >= m.autoApproveBelow ? 'review' : 'pass', value >= m.autoApproveBelow ? `${eur(value)} is over the limit, so it needs your OK.` : `${eur(value)}.`);
  }
  let decision = 'auto';
  if (checks.some((c) => c.status === 'block')) decision = 'blocked';
  else if (checks.some((c) => c.status === 'review')) decision = 'needs_approval';
  return {
    decision,
    action: String(action || 'payment').slice(0, 60),
    amount: value,
    checks,
    receipt: { mandateVersion: m.version || 1, evaluatedAt: now.toISOString(), agentId, agentName: agent ? agent.name : agentId, rationale: String(note || '').slice(0, 500) },
  };
}

module.exports.evaluateAction = evaluateAction;
