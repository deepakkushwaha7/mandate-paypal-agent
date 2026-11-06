# Devpost submission: Mandate

Paste each section into the matching Devpost field.

## Project name
Mandate

## Elevator pitch (max 200 chars)
An AI purchasing agent that pays suppliers through PayPal on its own, but only inside a spending mandate the buyer sets, and every payment can be undone.

## Inspiration
At Metis Labs we build BrandHub, a B2B platform where brands reorder branded packaging and merchandise. The most requested AI feature is "just reorder for me". The blocker is never the AI. It is trust: who lets an agent spend company money?

Human teams already solved this with spending policies, approval thresholds and the ability to cancel. We wanted the same guarantees for an AI agent, enforced by payment infrastructure rather than by a prompt.

## What it does
1. **The buyer grants a mandate once.** They save PayPal for the agent through PayPal Vault and set limits: monthly cap, per-order cap, an auto-pay threshold, allowed suppliers and categories, and the maximum supplier price rise.
2. **The agent watches stock and reorders.** Claude reads stock cover and supplier lead times, takes plain-language context ("Black Friday campaign starts in 2 weeks"), and proposes one order per supplier.
3. **A mandate engine decides, not the model.** Every proposal is priced from the catalogue and checked by deterministic code. The result is auto-pay, needs approval, or blocked, with reasons the agent reads and acts on.
4. **Payments are reversible.** In-policy orders are paid with a PayPal *authorization* against the vaulted account, with a live undo countdown. Undo voids the authorization and no money moves. When the window closes the payment is captured, and Undo becomes a refund.
5. **Humans handle the exceptions.** Larger or unusual orders, such as a supplier that quietly raised its price 6.9%, wait for the buyer, who approves in PayPal with one click. Approval re-checks the hard caps at that moment.
6. **Everything is logged.** An audit log records every agent decision and every PayPal ID.

## How we built it
- **PayPal Vault v3** for the one-time mandate: setup token, buyer approval, then payment token.
- **PayPal Orders v2** with `intent: AUTHORIZE` and `payment_source.paypal.vault_id` for payments the agent makes with no buyer present. The buyer-present approval flow is used for exceptions.
- **PayPal Payments v2** for capture after the undo window, void for undo, and refund for undo after capture. Every call has a `PayPal-Request-Id` for idempotent retries.
- **Claude (Anthropic) with tool use**: `get_stock`, `get_mandate`, `submit_order`, `finish`. `submit_order` returns the mandate verdict, so the agent self-corrects inside the boundaries.
- **AG Grid Community** for the live order grid, with status chips and inline Approve / Undo actions.
- Node.js and Express, live updates over Server-Sent Events, and a node:test suite of 11 tests covering the policy engine, PayPal payloads, the full agent run, undo, and the HTTP flow.
- Deployed on **Render** from the included `render.yaml`.

## Challenges we ran into
- **Fractions of a cent.** A packaging sticker costs €0.045, but PayPal amounts have two decimals. We send line items per supplier pack (3 × 1,000-pack at €45.00), so every item total reconciles exactly. Pack sizes are a real constraint in procurement, so this also makes the order clearer.
- **Keeping the model out of the money path.** The agent never sends prices or totals. It proposes SKUs and quantities, and the server prices and enforces everything. A prompt injection or a hallucination cannot raise the spend.
- **Making undo real.** Authorize-then-capture gives a true undo with no refund fees inside the window, and refunds cover the rest.

## Accomplishments that we're proud of
- An agent that can pay with no human present, safely, using standard PayPal primitives.
- The demo shows all three outcomes in one run: auto-paid, escalated (price drift), and blocked (supplier outside the mandate).
- It runs offline in a clearly labelled simulated mode, so anyone can try it in seconds, and switches to the real PayPal sandbox with two environment variables.

## What we learned
Agentic commerce needs the same controls finance teams already use (budgets, thresholds, approvals and reversals), built into the payment flow. PayPal's vault and authorization model fits this well.

## What's next for Mandate
- Bring it into BrandHub for real brand customers.
- Supplier-side payouts with PayPal Payouts, and invoices with the PayPal Invoicing API.
- Several mandates per team or cost centre, and per-agent spending reports.
- Expose `submit_order` as an MCP tool so any agent can buy within a PayPal mandate.

## Built with
paypal, paypal-vault, paypal-orders-api, anthropic, claude, ag-grid, node.js, express, javascript, render, server-sent-events

## Significant changes after 1 October 2026
The whole project was built during the submission period. The concept comes from our BrandHub roadmap, but all code in this repository is new.

## Testing instructions for judges
1. Open the hosted demo URL. The header shows whether PayPal is **sandbox** or **simulated**.
2. Click **Save PayPal for the agent** and approve. In sandbox mode, sign in with the sandbox buyer below.
3. Click **Run reorder check**. Watch the agent's steps and the three outcomes.
4. On an auto-paid order, click **Undo** before the countdown ends. The PayPal authorization is voided.
5. On a "Needs you" order, click **Approve in PayPal**.
6. Click **Reset demo** at any time.

Sandbox buyer (Netherlands, PayPal sandbox only): `sb-gepia53659455@personal.example.com` / `A*h7V8o4`

## AI tools used
Claude (Anthropic) is the purchasing agent at runtime, using tool use. Claude also helped build the project.
