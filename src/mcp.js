#!/usr/bin/env node
// Mandate MCP server: lets any MCP client (Claude Desktop, Cursor, your own
// agent) buy through a PayPal spending mandate. The agent can see its limits,
// dry-run a purchase, buy, and check status. It can never change the mandate
// or approve its own exceptions; those stay with the human in the dashboard.
//
// Config (env):
//   MANDATE_URL         base URL of the Mandate app (default http://localhost:3000)
//   MANDATE_AGENT_ID    which agent identity to use (default claude-desktop)
//   MANDATE_AGENT_KEY   the agent key shown in the dashboard (Agents → Connect an agent)

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

const BASE = (process.env.MANDATE_URL || 'http://localhost:3000').replace(/\/$/, '');
const AGENT = process.env.MANDATE_AGENT_ID || 'claude-desktop';

async function api(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  const key = process.env.MANDATE_AGENT_KEY || process.env.MANDATE_AGENT_TOKEN;
  if (key) headers.Authorization = `Bearer ${key}`;
  const res = await fetch(`${BASE}/api/agents/${AGENT}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Mandate returned ${res.status}`);
  return json;
}

const text = (obj) => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] });
const fail = (e) => ({ isError: true, content: [{ type: 'text', text: e.message }] });

function summarise(r) {
  const failed = (r.checks || []).filter((c) => c.status === 'block' || c.status === 'review');
  const head = {
    auto: `Paid via PayPal (authorization held; the buyer can undo it). Order ${r.orderId || ''}`.trim(),
    needs_approval: `Waiting for the buyer to approve in PayPal. Order ${r.orderId || ''}`.trim(),
    blocked: 'Blocked by the spending mandate. Nothing was charged.',
  }[r.decision];
  return [
    `${head} Total €${Number(r.total).toFixed(2)}.`,
    ...failed.map((c) => `- ${c.status === 'block' ? 'BLOCKED' : 'NEEDS HUMAN'}: ${c.label}. ${c.detail}`),
  ].join('\n');
}

const lines = z.array(z.object({
  sku: z.string().describe('Catalogue SKU, e.g. LBL-BAG-250'),
  qty: z.number().int().positive().describe('Units; must meet the minimum order and pack size'),
  reason: z.string().optional().describe('Short reason the buyer will read'),
})).min(1);

const server = new McpServer({ name: 'mandate', version: '1.0.0' });

server.tool(
  'get_spending_mandate',
  'Read your spending limits, budget left this month, approved suppliers, and the catalogue with stock levels. Call this before buying.',
  {},
  async () => {
    try {
      return text(await api('GET', '/context'));
    } catch (e) {
      return fail(e);
    }
  }
);

server.tool(
  'check_purchase',
  'Dry run: see whether a purchase would be paid automatically, need the buyer, or be blocked, with every rule checked. Charges nothing.',
  { lines, note: z.string().optional().describe('Why you want to buy this') },
  async ({ lines: l, note }) => {
    try {
      const r = await api('POST', '/check', { lines: l, note });
      return text(`${summarise(r)}\n\nRules checked:\n${r.checks.map((c) => `- [${c.status}] ${c.label}: ${c.detail}`).join('\n')}`);
    } catch (e) {
      return fail(e);
    }
  }
);

server.tool(
  'purchase',
  'Buy from one supplier through the PayPal mandate. In-policy orders are paid at once (as a PayPal authorization the buyer can undo); others wait for the buyer or are blocked. Never retry a blocked purchase with tweaks to get around a rule; tell the user instead.',
  { lines, note: z.string().describe('One sentence for the buyer explaining this purchase') },
  async ({ lines: l, note }) => {
    try {
      return text(summarise(await api('POST', '/purchase', { lines: l, note })));
    } catch (e) {
      return fail(e);
    }
  }
);

server.tool(
  'get_order_status',
  'Check an order you placed: paying, held (undo open), paid, undone, refunded or waiting for approval.',
  { orderId: z.string() },
  async ({ orderId }) => {
    try {
      return text(await api('GET', `/orders/${encodeURIComponent(orderId)}`));
    } catch (e) {
      return fail(e);
    }
  }
);

server.connect(new StdioServerTransport()).catch((e) => {
  process.stderr.write(`Mandate MCP failed to start: ${e.message}\n`);
  process.exit(1);
});
