// Put Mandate in front of PayPal's official Agent Toolkit.
//
// PayPal's Agent Toolkit lets an LLM call PayPal directly (refunds, invoices,
// orders, subscriptions). It has no spending limits or human approval step
// of its own. This wrapper asks Mandate before any money-moving tool runs:
// allowed calls go through, others are held for a human or refused, and
// every decision lands in the Mandate audit log.
//
//   npm install @paypal/agent-toolkit openai
//   MANDATE_URL=https://mandate-aadp.onrender.com MANDATE_AGENT_KEY=mk_... node your-agent.js
//
// Usage:
//   const { PayPalAgentToolkit } = require('@paypal/agent-toolkit/openai');
//   const toolkit = new PayPalAgentToolkit({ clientId, clientSecret, configuration: { actions: { payments: { refund: true }, invoices: { create: true, send: true } } } });
//   const guarded = guardToolkit(toolkit, { agentId: 'claude-desktop' });
//   const result = await guarded.handleToolCall(toolCall); // same API as the toolkit

// Tools that move money, and how to read the amount from their arguments.
const MONEY_TOOLS = {
  create_refund: (a) => a.amount && a.amount.value,
  create_order: (a) => a.items && a.items.reduce((s, i) => s + Number(i.itemCost || 0) * Number(i.quantity || 1), 0),
  pay_order: () => null,
  send_invoice: () => null,
  create_invoice: (a) => a.items && a.items.reduce((s, i) => s + Number((i.unit_amount && i.unit_amount.value) || 0) * Number(i.quantity || 1), 0),
  create_subscription: () => null,
  accept_dispute_claim: () => null,
};

function guardToolkit(toolkit, { agentId, mandateUrl = process.env.MANDATE_URL, agentKey = process.env.MANDATE_AGENT_KEY, fetchImpl = fetch } = {}) {
  async function authorize(name, args) {
    const read = MONEY_TOOLS[name];
    const amount = Number(read(args));
    if (!Number.isFinite(amount) || amount <= 0) {
      // Amount unknown up front (e.g. sending an existing invoice): a human decides.
      return { decision: 'needs_approval', checks: [{ label: 'Amount known in advance', status: 'review', detail: `${name} has no amount to check.` }] };
    }
    const res = await fetchImpl(`${mandateUrl.replace(/\/$/, '')}/api/agents/${agentId}/authorize-action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${agentKey}` },
      body: JSON.stringify({ action: name, amount, note: args.note || args.reason || '' }),
    });
    if (!res.ok) throw new Error(`Mandate refused the check (${res.status}).`);
    return res.json();
  }

  return {
    getTools: () => toolkit.getTools(),
    async handleToolCall(toolCall) {
      const name = toolCall.function.name;
      if (!(name in MONEY_TOOLS)) return toolkit.handleToolCall(toolCall); // read-only tools pass through
      const args = JSON.parse(toolCall.function.arguments || '{}');
      const v = await authorize(name, args);
      if (v.decision === 'auto') return toolkit.handleToolCall(toolCall);
      const why = v.checks.filter((c) => c.status !== 'pass').map((c) => `${c.label}: ${c.detail}`).join(' ');
      return {
        role: 'tool',
        tool_call_id: toolCall.id,
        content: JSON.stringify({
          error: v.decision === 'blocked' ? 'Blocked by the spending mandate.' : 'Held for the buyer to approve.',
          reasons: why,
          instruction: 'Do not retry with changes to get around this. Tell the user.',
        }),
      };
    },
  };
}

module.exports = { guardToolkit, MONEY_TOOLS };
