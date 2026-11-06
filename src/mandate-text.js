// Turns a mandate written in plain English into structured rules.
// With ANTHROPIC_API_KEY, Claude extracts the rules with a strict tool schema.
// Without it, a pattern parser handles the common phrasings.
// Either way the result is only a proposal: the buyer sees the changes and
// confirms them before anything is saved.

const FIELDS = {
  monthlyCap: 'Monthly cap',
  perOrderCap: 'Per-order cap',
  autoApproveBelow: 'Auto-pay below',
  maxPriceIncreasePct: 'Max supplier price rise',
  undoWindowSec: 'Undo window',
  allowedSupplierIds: 'Approved suppliers',
  allowedCategories: 'Approved categories',
  active: 'Agents may spend',
};

function num(s) {
  if (s == null) return null;
  let t = String(s).toLowerCase().replace(/[€$,\s]/g, '').replace(/eur/, '');
  let mult = 1;
  if (t.endsWith('k')) { mult = 1000; t = t.slice(0, -1); }
  const n = Number(t);
  return Number.isFinite(n) ? n * mult : null;
}

const AMOUNT = '(?:€|eur\\s*|\\$)?\\s*([\\d][\\d,.]*\\s*k?)';

function parseHeuristic(text, state) {
  const t = ` ${text.toLowerCase()} `;
  const out = {};
  let m;
  if ((m = t.match(new RegExp(`${AMOUNT}\\s*(?:a|per|each|/|every)\\s*month`))) || (m = t.match(new RegExp(`month(?:ly)?(?:\\s+(?:cap|budget|limit))?(?:\\s+(?:of|is|at))?\\s*${AMOUNT}`)))) out.monthlyCap = num(m[1]);
  if ((m = t.match(new RegExp(`${AMOUNT}\\s*(?:a|per|each|/|an)\\s*order`))) || (m = t.match(new RegExp(`(?:per|each|any single|a single|one)\\s*order(?:\\s+(?:cap|limit|max(?:imum)?))?(?:\\s+(?:of|is|at|over|above))?\\s*${AMOUNT}`)))) out.perOrderCap = num(m[1]);
  if ((m = t.match(new RegExp(`(?:under|below|less than|up to)\\s*${AMOUNT}[^.]*?(?:own|auto|without|automatically|yourself)`))) ||
      (m = t.match(new RegExp(`(?:nothing|anything|no(?:thing)? order)\\s*(?:over|above|more than)\\s*${AMOUNT}\\s*without`))) ||
      (m = t.match(new RegExp(`auto[- ]?pay(?:\\s+(?:below|under|up to))?\\s*${AMOUNT}`)))) out.autoApproveBelow = num(m[1]);
  if ((m = t.match(/(?:price|prices)[^.]*?(\d+(?:\.\d+)?)\s*%/)) || (m = t.match(/(\d+(?:\.\d+)?)\s*%[^.]*price/))) out.maxPriceIncreasePct = Number(m[1]);
  if ((m = t.match(/undo[^.]*?(\d+)\s*(second|sec|s\b|minute|min)/))) out.undoWindowSec = Number(m[1]) * (/min/.test(m[2]) ? 60 : 1);

  const cats = [...new Set(state.catalogue.map((c) => c.category))];
  const namedCats = cats.filter((c) => new RegExp(`\\b${c}`).test(t));
  if (namedCats.length && /\b(only|just|allow(?:ed)?|approved|include|add)\b/.test(t)) out.allowedCategories = namedCats;

  const namedSup = state.suppliers.filter((s) => t.includes(s.name.toLowerCase().split(' ')[0]));
  if (namedSup.length) out.allowedSupplierIds = namedSup.map((s) => s.id);

  if (/\b(pause|stop|freeze|halt)\b[^.]*\b(agent|spend|buying|all)/.test(t)) out.active = false;
  else if (/\b(resume|unpause|re-?enable)\b/.test(t)) out.active = true;

  for (const k of Object.keys(out)) if (out[k] === null || Number.isNaN(out[k])) delete out[k];
  return out;
}

async function parseClaude(text, state, apiKey, model) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey });
  const tool = {
    name: 'set_mandate',
    description: 'Record the spending rules the buyer described. Only include fields the buyer actually stated.',
    input_schema: {
      type: 'object',
      properties: {
        monthlyCap: { type: 'number', description: 'Maximum total spend per calendar month, in EUR.' },
        perOrderCap: { type: 'number', description: 'Maximum for a single order, in EUR.' },
        autoApproveBelow: { type: 'number', description: 'Orders below this EUR amount may be paid without asking the buyer.' },
        maxPriceIncreasePct: { type: 'number', description: 'Largest supplier price rise (percent) that can still be auto-paid.' },
        undoWindowSec: { type: 'integer', description: 'Seconds the buyer can undo an agent payment before capture.' },
        allowedSupplierIds: { type: 'array', items: { type: 'string', enum: state.suppliers.map((s) => s.id) } },
        allowedCategories: { type: 'array', items: { type: 'string', enum: [...new Set(state.catalogue.map((c) => c.category))] } },
        active: { type: 'boolean', description: 'false if the buyer wants all agent spending paused.' },
      },
    },
  };
  const res = await client.messages.create({
    model,
    max_tokens: 600,
    tools: [tool],
    tool_choice: { type: 'tool', name: 'set_mandate' },
    system: `Extract spending rules for a purchasing agent. Suppliers: ${state.suppliers.map((s) => `${s.id} = ${s.name}`).join('; ')}. Amounts are EUR. Never invent a rule the buyer did not state.`,
    messages: [{ role: 'user', content: text }],
  });
  const use = res.content.find((b) => b.type === 'tool_use');
  return use ? use.input : {};
}

function diff(mandate, proposed, state) {
  const fmt = (k, v) => {
    if (k === 'allowedSupplierIds') return v.map((id) => (state.suppliers.find((s) => s.id === id) || {}).name || id).join(', ');
    if (k === 'allowedCategories') return v.join(', ');
    if (k === 'maxPriceIncreasePct') return `${v}%`;
    if (k === 'undoWindowSec') return `${v}s`;
    if (k === 'active') return v ? 'Yes' : 'No (paused)';
    return `€${Number(v).toLocaleString('en-IE')}`;
  };
  const changes = [];
  for (const [k, v] of Object.entries(proposed)) {
    if (!(k in FIELDS)) continue;
    const before = mandate[k];
    if (JSON.stringify(before) === JSON.stringify(v)) continue;
    changes.push({ field: k, label: FIELDS[k], from: fmt(k, before), to: fmt(k, v) });
  }
  return changes;
}

function validate(p, state) {
  const out = {};
  for (const k of ['monthlyCap', 'perOrderCap', 'autoApproveBelow']) if (typeof p[k] === 'number' && p[k] >= 0 && p[k] <= 1e6) out[k] = Math.round(p[k] * 100) / 100;
  if (typeof p.maxPriceIncreasePct === 'number' && p.maxPriceIncreasePct >= 0 && p.maxPriceIncreasePct <= 100) out.maxPriceIncreasePct = p.maxPriceIncreasePct;
  if (Number.isInteger(p.undoWindowSec) && p.undoWindowSec >= 10 && p.undoWindowSec <= 86400) out.undoWindowSec = p.undoWindowSec;
  if (Array.isArray(p.allowedSupplierIds)) out.allowedSupplierIds = p.allowedSupplierIds.filter((id) => state.suppliers.some((s) => s.id === id));
  const cats = new Set(state.catalogue.map((c) => c.category));
  if (Array.isArray(p.allowedCategories)) out.allowedCategories = p.allowedCategories.filter((c) => cats.has(c));
  if (typeof p.active === 'boolean') out.active = p.active;
  return out;
}

async function parseMandate(text, state) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';
  let raw;
  let engine = 'rules';
  if (apiKey) {
    try {
      raw = await parseClaude(text, state, apiKey, model);
      engine = 'claude';
    } catch (e) {
      raw = parseHeuristic(text, state);
    }
  } else {
    raw = parseHeuristic(text, state);
  }
  const proposed = validate(raw, state);
  const warnings = [];
  const next = { ...state.mandate, ...proposed };
  if (next.autoApproveBelow > next.perOrderCap) warnings.push('Auto-pay limit is higher than the per-order cap, so the cap wins.');
  if (next.perOrderCap > next.monthlyCap) warnings.push('Per-order cap is higher than the monthly cap.');
  return { engine, proposed, changes: diff(state.mandate, proposed, state), warnings };
}

module.exports = { parseMandate, parseHeuristic, validate, diff, FIELDS };
