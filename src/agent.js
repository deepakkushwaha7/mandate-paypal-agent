// The purchasing agent. It reads stock and the mandate, then proposes one
// order per supplier through the submit_order tool. Every submission is
// checked by the mandate engine (policy.js) and the verdict is returned to
// the agent, so it can correct a proposal or report why it gave up.
//
// With ANTHROPIC_API_KEY set, Claude plans the orders with tool use.
// Without it, a deterministic planner follows the same tool protocol, so
// the demo and tests run offline.

const { evaluate, spentThisMonth, round2, eur } = require('./policy');

const SAFETY_DAYS = 7;
const COVER_DAYS = 30;
const MAX_TURNS = 10;

function stockView(state) {
  return state.inventory.map((inv) => {
    const c = state.catalogue.find((x) => x.sku === inv.sku);
    const sup = state.suppliers.find((s) => s.id === c.supplierId);
    return {
      sku: inv.sku,
      name: c.name,
      category: c.category,
      supplierId: c.supplierId,
      supplierName: sup.name,
      onHand: inv.onHand,
      dailyUsage: inv.dailyUsage,
      coverDays: round2(inv.onHand / inv.dailyUsage),
      leadTimeDays: c.leadTimeDays,
      unitPrice: c.unitPrice,
      lastPaidUnitPrice: state.priceHistory[inv.sku] || null,
      moq: c.moq,
      packSize: c.packSize,
    };
  });
}

function mandateView(state) {
  const m = state.mandate;
  const spent = spentThisMonth(state);
  return {
    currency: m.currency,
    active: m.active,
    monthlyCap: m.monthlyCap,
    spentThisMonth: spent,
    remainingThisMonth: round2(m.monthlyCap - spent),
    perOrderCap: m.perOrderCap,
    autoPayBelow: m.autoApproveBelow,
    allowedSuppliers: m.allowedSupplierIds.map((id) => state.suppliers.find((s) => s.id === id).name),
    allowedCategories: m.allowedCategories,
    maxPriceIncreasePct: m.maxPriceIncreasePct,
    paymentMethodSaved: Boolean(m.vaultId),
  };
}

const TOOLS = [
  {
    name: 'get_stock',
    description: 'Current stock per SKU with daily usage, days of cover, supplier lead time, price, minimum order quantity (moq) and pack size.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_mandate',
    description: 'The spending mandate the buyer granted: caps, auto-pay limit, allowed suppliers and categories, and budget left this month.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'submit_order',
    description: 'Propose one purchase order to ONE supplier. The mandate engine prices it from the catalogue and returns a decision: auto (will be paid via PayPal), needs_approval (a human approves in PayPal), or blocked (not placed; fix it or drop it).',
    input_schema: {
      type: 'object',
      properties: {
        lines: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              sku: { type: 'string' },
              qty: { type: 'integer', description: 'Units. Must be >= moq and a multiple of packSize.' },
              reason: { type: 'string', description: 'One short sentence a buyer can read, e.g. "7 days cover, lead time 7 days".' },
            },
            required: ['sku', 'qty', 'reason'],
          },
        },
        note: { type: 'string', description: 'One sentence explaining this order to the buyer.' },
      },
      required: ['lines', 'note'],
    },
  },
  {
    name: 'finish',
    description: 'End the run with a short summary for the buyer: what you ordered, what needs their approval, and what you could not order and why.',
    input_schema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] },
  },
];

const SYSTEM = `You are the purchasing agent for a direct-to-consumer brand. You keep branded packaging and labels in stock by placing supplier orders that are paid through PayPal under a spending mandate the buyer granted you.

How to work:
1. Call get_stock and get_mandate.
2. A SKU needs reordering when its days of cover is below lead time + ${SAFETY_DAYS} safety days. Order enough to cover lead time + ${COVER_DAYS} days of usage, rounded up to the pack size and at least the moq. Follow any extra instruction from the buyer (for example a campaign that raises demand).
3. Submit one order per supplier with submit_order. Never mix suppliers.
4. Read the verdict. If an order is blocked, fix it if a compliant version still meets the need (e.g. wrong pack size). If the block is a mandate boundary (supplier or category not allowed, caps), do not try to get around it: drop it and tell the buyer.
5. Call finish with a plain, short summary.

You cannot change prices or the mandate. Spend the buyer's money as carefully as they would.`;

function planHeuristic(state, instruction) {
  const boost = /campaign|black friday|promo|peak|double|launch/i.test(instruction || '') ? 21 : 0;
  const stock = stockView(state);
  const needs = [];
  for (const s of stock) {
    const trigger = s.leadTimeDays + SAFETY_DAYS;
    if (s.coverDays >= trigger + boost) continue;
    const target = (s.leadTimeDays + COVER_DAYS + boost) * s.dailyUsage;
    let qty = Math.max(target - s.onHand, s.moq);
    qty = Math.ceil(qty / s.packSize) * s.packSize;
    needs.push({
      ...s,
      qty,
      reason: `${s.coverDays} days cover, lead time ${s.leadTimeDays} days${boost ? ', +21 days for the campaign' : ''}.`,
    });
  }
  const bySupplier = new Map();
  for (const n of needs) {
    if (!bySupplier.has(n.supplierId)) bySupplier.set(n.supplierId, []);
    bySupplier.get(n.supplierId).push(n);
  }
  return { stock, needs, bySupplier, boost };
}

async function runHeuristic({ state, instruction, emit, submit }) {
  emit({ kind: 'tool', name: 'get_stock', text: 'Reading stock levels and usage.' });
  emit({ kind: 'tool', name: 'get_mandate', text: 'Reading the spending mandate.' });
  const { needs, bySupplier, boost } = planHeuristic(state, instruction);
  if (boost) emit({ kind: 'thought', text: 'The buyer mentioned a campaign, so I am planning 21 extra days of cover.' });
  if (needs.length === 0) {
    const summary = 'Every SKU has enough cover. No orders needed today.';
    emit({ kind: 'finish', text: summary });
    return { summary };
  }
  emit({
    kind: 'thought',
    text: `${needs.length} SKUs are below lead time + ${SAFETY_DAYS} days: ${needs.map((n) => `${n.sku} (${n.coverDays} d)`).join(', ')}. Grouping into ${bySupplier.size} supplier orders.`,
  });
  const notes = [];
  for (const [supplierId, lines] of bySupplier) {
    const sup = state.suppliers.find((s) => s.id === supplierId);
    const verdict = submit({
      lines: lines.map((l) => ({ sku: l.sku, qty: l.qty, reason: l.reason })),
      note: `Restock from ${sup.name}.`,
    });
    if (verdict.decision === 'blocked') {
      const hard = verdict.reasons.filter((r) => r.severity === 'block').map((r) => r.message);
      emit({ kind: 'thought', text: `Blocked by the mandate, so I will not place it: ${hard.join(' ')}` });
      notes.push(`Could not order from ${sup.name}: ${hard[0]}`);
    } else if (verdict.decision === 'needs_approval') {
      notes.push(`${sup.name} order (${eur(verdict.total)}) needs your approval.`);
    } else {
      notes.push(`${sup.name} order (${eur(verdict.total)}) paid automatically.`);
    }
  }
  const summary = notes.join(' ');
  emit({ kind: 'finish', text: summary });
  return { summary };
}

async function runClaude({ state, instruction, emit, submit, apiKey, model }) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey });
  const messages = [{
    role: 'user',
    content: `Today is ${new Date().toISOString().slice(0, 10)}. Run your reorder check.${instruction ? `\n\nInstruction from the buyer: ${instruction}` : ''}`,
  }];
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const res = await client.messages.create({ model, max_tokens: 2000, system: SYSTEM, tools: TOOLS, messages });
    messages.push({ role: 'assistant', content: res.content });
    const results = [];
    let finished = null;
    for (const block of res.content) {
      if (block.type === 'text' && block.text.trim()) emit({ kind: 'thought', text: block.text.trim() });
      if (block.type !== 'tool_use') continue;
      let out;
      if (block.name === 'get_stock') {
        emit({ kind: 'tool', name: 'get_stock', text: 'Reading stock levels and usage.' });
        out = stockView(state);
      } else if (block.name === 'get_mandate') {
        emit({ kind: 'tool', name: 'get_mandate', text: 'Reading the spending mandate.' });
        out = mandateView(state);
      } else if (block.name === 'submit_order') {
        const v = submit(block.input);
        out = { decision: v.decision, total: v.total, reasons: v.reasons.map((r) => `${r.severity}: ${r.message}`), budgetLeftAfter: v.budget.afterOrder };
      } else if (block.name === 'finish') {
        finished = block.input.summary;
        out = { ok: true };
      } else {
        out = { error: `Unknown tool ${block.name}` };
      }
      results.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(out) });
    }
    if (finished) {
      emit({ kind: 'finish', text: finished });
      return { summary: finished };
    }
    if (res.stop_reason !== 'tool_use') {
      const summary = res.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim() || 'Run ended.';
      emit({ kind: 'finish', text: summary });
      return { summary };
    }
    messages.push({ role: 'user', content: results });
  }
  const summary = 'Stopped after the maximum number of steps.';
  emit({ kind: 'finish', text: summary });
  return { summary };
}

// Runs the agent. `onProposal(evaluation, input)` is called for every
// submit_order so the caller can create orders as the agent works.
async function runAgent({ state, instruction, emit, onProposal }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';
  const submit = (input) => {
    const v = evaluate(state, { ...input, agentId: 'reorder-agent' });
    emit({
      kind: 'proposal',
      decision: v.decision,
      total: v.total,
      text: `Proposed ${v.lines.map((l) => `${l.qty.toLocaleString('en')} × ${l.sku}`).join(', ') || 'nothing valid'} for ${eur(v.total)}.`,
      reasons: v.reasons,
      checks: v.checks,
    });
    onProposal(v, input);
    return v;
  };
  const engine = apiKey ? 'claude' : 'rules';
  emit({ kind: 'start', engine, model: apiKey ? model : 'deterministic planner', text: instruction ? `Instruction: ${instruction}` : 'Scheduled reorder check.' });
  if (apiKey) return runClaude({ state, instruction, emit, submit, apiKey, model });
  return runHeuristic({ state, instruction, emit, submit });
}

module.exports = { runAgent, planHeuristic, stockView, mandateView, TOOLS, SYSTEM };
