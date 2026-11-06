# Mandate

**An AI purchasing agent that pays suppliers through PayPal within a spending mandate, with an undo window.**

Brands that sell online run out of boring things: mailer boxes, tissue paper, labels. Reordering them is easy to automate but risky to hand to an AI, because an agent with a card can overspend, order from the wrong supplier, or accept a price rise nobody noticed.

Mandate fixes the trust problem with three ideas:

1. **The buyer grants a mandate once.** They save PayPal for the agent (PayPal Vault) and set limits: monthly cap, per-order cap, an auto-pay threshold, allowed suppliers and categories, and the maximum supplier price rise.
2. **Code, not the model, decides what gets paid.** The agent only proposes SKUs and quantities. A deterministic mandate engine prices every proposal from the catalogue and returns `auto`, `needs_approval` or `blocked`, with the reasons. The agent reads the verdict and corrects itself or reports why it gave up.
3. **Every agent payment can be undone.** Payments are PayPal *authorizations*, not captures. For the undo window (default 60 seconds) the buyer can void with one tap and no money moves. After capture, Undo becomes a refund.

## Why this matters

PayPal's Agent Toolkit and MCP servers let agents create orders, invoices and refunds, but they have **no built-in human-confirmation gate or spending limits**. Developers must build their own ([Vorp Labs review](https://vorplabs.com/agent-tools/paypal-agent-toolkit)). Meanwhile about three-quarters of consumers won't let an agent pay on its own, even with preset limits (Forrester, April 2026). Mandate is that missing layer, and it answers the three trust problems people name most often:

| Problem | What Mandate does |
| --- | --- |
| Agents split purchases to stay under limits | The auto-pay limit applies to the **rolling 24-hour total per supplier** |
| Logs show what happened, not why it was allowed | Every order has a **decision receipt**: all 14 rules, pass / needs a human / blocked, mandate version and the agent's own reason |
| No real kill switch | **Stop all agents** pauses every agent and voids all open PayPal authorizations in one step |

## Features

- **Spending mandate in plain English.** Write the rules in a sentence. Claude turns them into rules, and you see before/after for each change and apply.
- **Many agents, one mandate.** The built-in reorder agent and any external agent (Claude Desktop, Cursor) via **MCP**, each with its own identity, on/off switch and monthly budget.
- **Undo on every agent payment.** PayPal authorizations with an undo window, a toast with countdown, void before capture, refund after.
- **Approval inbox** for exceptions, with the reason and one-click approval in PayPal. Approval re-checks the hard caps at that moment.
- **Resilient PayPal flow.** If PayPal refuses to charge the saved account (`NOT_ENABLED_TO_VAULT_PAYMENT_SOURCE`, a common sandbox issue), orders fall back to approval in PayPal instead of failing. Verified webhooks keep status in sync.

## What happens in the demo

| SKU | Days of cover | Agent proposes | Mandate engine says | Why |
| --- | --- | --- | --- | --- |
| Tissue paper (Tissu Print) | 15 | 1,500 units, €165 | **Auto-pay** | Below €400, in policy |
| Bag labels (LabelWorks) | 8.6 | 4,000 units, €280 | **Auto-pay** | Below €400, in policy |
| Mailer box S (Boxly) | 7.4 | 1,250 units, €775 | **Needs you** | Above €400, and the supplier raised the price 6.9% (limit 5%) |
| Canvas totes (PromoMax) | 13.3 | 150 units, €360 | **Blocked** | Supplier and category are outside the mandate |

Approving opens PayPal. Auto-paid orders show a live **Undo** countdown, then capture automatically.

## PayPal integration

Verified end to end on the PayPal sandbox (6 Nov 2026) with a Netherlands merchant and buyer: buyer saves PayPal (Vault v3) → agent authorizes €165 with no buyer present → capture → refund; agent authorizes €280 → void; buyer-approved €275 order → authorize → capture.

| Step | PayPal API |
| --- | --- |
| Buyer saves PayPal for the agent | Vault v3: `POST /v3/vault/setup-tokens` → buyer approves → `POST /v3/vault/payment-tokens` |
| Agent pays within the mandate (no buyer present) | Orders v2: `POST /v2/checkout/orders` with `intent: AUTHORIZE` and `payment_source.paypal.vault_id` |
| Human approves a larger order | Orders v2: create with `intent: AUTHORIZE` → buyer approves → `POST /v2/checkout/orders/{id}/authorize` |
| Undo window closes | Payments v2: `POST /v2/payments/authorizations/{id}/capture` |
| Undo before capture | Payments v2: `POST /v2/payments/authorizations/{id}/void` |
| Undo after capture | Payments v2: `POST /v2/payments/captures/{id}/refund` |

Every call carries a `PayPal-Request-Id`, so retries are idempotent. Line items are sent per supplier pack (e.g. `3 × 1,000-pack at €45.00`), because packaging often costs fractions of a cent per unit and PayPal amounts allow two decimals. Item totals always reconcile to the order total.

## AI

The purchasing agent is an LLM with tool use: `get_stock`, `get_mandate`, `submit_order` (returns the mandate verdict, so the model self-corrects) and `finish`. It takes plain-language context such as "Black Friday campaign starts in 2 weeks" and plans extra cover. The same model turns a plain-English mandate into structured rules through a strict function schema.

Supported models (set one key): **Google Gemini** (`GEMINI_API_KEY`, free tier, default `gemini-3.8-flash`), **Anthropic Claude** (`ANTHROPIC_API_KEY`) or **Llama on Groq** (`GROQ_API_KEY`). If the model is unavailable before it proposes anything, a deterministic planner that follows the same tool protocol takes over, so a buyer is never stuck. With no key at all, the app, the tests and the demo still run offline.

## For judges: what to try (3 minutes)

Open the hosted demo. Every visitor gets a **private demo workspace**, so nothing you click affects anyone else.

1. **Take the tour** (top right), or follow the three steps on the welcome card.
2. **Save PayPal for agents** and approve in the PayPal sandbox with the test buyer below.
3. **Edit your rules** in plain English, for example *"Keep it under 3k a month, nothing over €400 without me"*, then **Preview changes** and **Apply**.
4. **Run agent** with the *Black Friday* suggestion. You'll see one order paid automatically, two waiting for you, and one blocked.
5. Click any payment to read its **decision receipt**. Press **Undo** on the paid one, approve a waiting one in PayPal, then try **Stop all agents**.

## PayPal Agent Toolkit guard

PayPal's [Agent Toolkit](https://github.com/paypal/agent-toolkit) lets an LLM call PayPal directly, but it has no spending limits or approval step of its own. `examples/paypal-agent-toolkit-guard.js` wraps it with the same API. Read-only tools pass through. Money-moving tools (`create_refund`, `create_order`, `create_invoice`, `send_invoice`, `pay_order`, `create_subscription`, `accept_dispute_claim`) are checked against your mandate first: **allowed**, **held for a human**, or **blocked**. Every decision goes into the audit log.

```js
const { PayPalAgentToolkit } = require('@paypal/agent-toolkit/openai');
const { guardToolkit } = require('./examples/paypal-agent-toolkit-guard');
const guarded = guardToolkit(new PayPalAgentToolkit({ clientId, clientSecret, configuration }), {
  agentId: 'claude-desktop', mandateUrl: 'https://mandate-aadp.onrender.com', agentKey: 'mk_…',
});
await guarded.handleToolCall(toolCall);
```

We ship it as a wrapper rather than a dependency on purpose: the toolkit package currently pulls in 12 known high-severity vulnerabilities through pinned dependencies, and Mandate's production dependency tree has none.

## Connect any agent with MCP

```json
{
  "mcpServers": {
    "mandate": {
      "command": "npx",
      "args": ["-y", "-p", "github:deepakkushwaha7/mandate-paypal-agent", "mandate-mcp"],
      "env": { "MANDATE_URL": "https://mandate-aadp.onrender.com", "MANDATE_AGENT_ID": "claude-desktop", "MANDATE_AGENT_KEY": "mk_… (Agents → Connect an agent)" }
    }
  }
}
```

Tools: `get_spending_mandate`, `check_purchase` (dry run with every rule), `purchase`, `get_order_status`. Agents can never change the mandate or approve their own exceptions.

## Security

- Secrets only in environment variables (see `.env.example`). Nothing secret is stored in the repo or sent to the browser.
- Strict Content-Security-Policy, no framing, `nosniff`, HSTS behind HTTPS, and no `x-powered-by` header.
- Every visitor gets a private workspace keyed by an HttpOnly, SameSite cookie. External agents authenticate with a per-workspace agent key (constant-time compare), never the session cookie.
- Cross-site writes are blocked (Origin and `Sec-Fetch-Site` checks).
- Rate limiting and request size limits. PayPal webhooks are trusted only after PayPal verifies the signature.
- Per-order locks, so a double-click can't void or approve twice. Every PayPal call is idempotent (`PayPal-Request-Id`).
- The model never sets prices or totals: the server prices every line from the catalogue.
- `npm audit`: 0 known vulnerabilities in production dependencies.

## Quality

`npm run check` runs ESLint and **35 unit and integration tests**, and `npm run e2e` drives the full judge journey in a real browser (tour, save PayPal, rules, agent run, receipt, undo, approve, stop all, phone width): policy rules, PayPal payloads, the full agent run, undo/void/refund, split orders, the kill switch, vault fallback, webhooks, the plain-English parser, the HTTP API, an end-to-end MCP client, and security (headers, CSRF, auth, limits, double-click). GitHub Actions runs the same checks on Node 20 and 22. The design system is in [DESIGN.md](DESIGN.md).

## Run it

```bash
npm install
npm start            # http://localhost:3000
npm run check        # lint + 35 tests
npm run e2e          # browser end-to-end (Playwright)
```

With no credentials the app runs a **simulated PayPal** (clearly labelled in the header) so anyone can try the full flow.

To use the real PayPal sandbox and Claude:

```bash
export PAYPAL_CLIENT_ID=...        # developer.paypal.com → Apps & Credentials → Sandbox
export PAYPAL_CLIENT_SECRET=...
export PAYPAL_ENV=sandbox
export GEMINI_API_KEY=...          # free at aistudio.google.com/apikey (or ANTHROPIC_API_KEY / GROQ_API_KEY)
export PUBLIC_URL=https://your-host  # needed for PayPal return URLs when not on localhost
npm start
```

In the sandbox app settings, make sure **Vault** is enabled (Apps & Credentials → your app → Features → Vault).

To approve orders, sign in to the PayPal pop-up with a **sandbox personal account** (developer.paypal.com → Testing Tools → Sandbox Accounts).

### Deploy on Render

`render.yaml` is included: New → Blueprint → select this repo, then add the environment variables above. Render sets `RENDER_EXTERNAL_URL`, which the app uses for PayPal return URLs.

## Test credentials for judges

- **Hosted demo:** see the Devpost submission for the URL.
- **PayPal sandbox buyer:** see the Devpost submission's testing instructions.
- **Reset:** the "Reset demo" button restores the starting data at any time.

## Project layout

```
src/policy.js   mandate engine (pure, tested)
src/agent.js    Claude tool-use agent + deterministic planner
src/paypal.js   PayPal REST client + simulator with the same interface
src/orders.js   order lifecycle: authorize, approve, undo (void/refund), capture
src/server.js   Express API, live updates over Server-Sent Events
src/security.js headers, same-origin check, rate limit
src/workspace.js private demo workspace per visitor
src/llm.js      Gemini / Claude / Groq adapter with planner fallback
examples/       PayPal Agent Toolkit guard
src/mcp.js      MCP server for external agents
src/mandate-text.js  plain-English mandate → rules (Claude or parser)
public/         dashboard (AG Grid order grid, vanilla JS)
test/           node:test suite
```

## Built with

PayPal Vault v3, Orders v2 and Payments v2 (sandbox) · Google Gemini or Anthropic Claude (tool use) · AG Grid Community · Node.js and Express · Render

## Licence

MIT. See [LICENSE](LICENSE).
