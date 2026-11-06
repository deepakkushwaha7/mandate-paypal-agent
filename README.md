# Mandate

**An AI purchasing agent that pays suppliers through PayPal within a spending mandate, with an undo window.**

Brands that sell online run out of boring things: mailer boxes, tissue paper, labels. Reordering them is easy to automate but risky to hand to an AI, because an agent with a card can overspend, order from the wrong supplier, or accept a price rise nobody noticed.

Mandate fixes the trust problem with three ideas:

1. **The buyer grants a mandate once.** They save PayPal for the agent (PayPal Vault) and set limits: monthly cap, per-order cap, an auto-pay threshold, allowed suppliers and categories, and the maximum supplier price rise.
2. **Code, not the model, decides what gets paid.** The agent only proposes SKUs and quantities. A deterministic mandate engine prices every proposal from the catalogue and returns `auto`, `needs_approval` or `blocked`, with the reasons. The agent reads the verdict and corrects itself or reports why it gave up.
3. **Every agent payment can be undone.** Payments are PayPal *authorizations*, not captures. For the undo window (default 60 seconds) the buyer can void with one tap and no money moves. After capture, Undo becomes a refund.

## What happens in the demo

| SKU | Days of cover | Agent proposes | Mandate engine says | Why |
| --- | --- | --- | --- | --- |
| Tissue paper (Tissu Print) | 15 | 1,500 units, €165 | **Auto-pay** | Below €400, in policy |
| Bag labels (LabelWorks) | 8.6 | 4,000 units, €280 | **Auto-pay** | Below €400, in policy |
| Mailer box S (Boxly) | 7.4 | 1,250 units, €775 | **Needs you** | Above €400, and the supplier raised the price 6.9% (limit 5%) |
| Canvas totes (PromoMax) | 13.3 | 150 units, €360 | **Blocked** | Supplier and category are outside the mandate |

Approving opens PayPal. Auto-paid orders show a live **Undo** countdown, then capture automatically.

## PayPal integration

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

With `ANTHROPIC_API_KEY` set, **Claude** plans the orders with tool use: `get_stock`, `get_mandate`, `submit_order` (returns the mandate verdict), `finish`. It also takes plain-language instructions such as "Black Friday campaign starts in 2 weeks" and plans extra cover.

Without a key, a deterministic planner follows the same tool protocol, so the app, the tests and the demo work offline.

## Run it

```bash
npm install
npm start            # http://localhost:3000
npm test             # 11 tests: policy, PayPal payloads, agent run, undo, HTTP flow
```

With no credentials the app runs a **simulated PayPal** (clearly labelled in the header) so anyone can try the full flow.

To use the real PayPal sandbox and Claude:

```bash
export PAYPAL_CLIENT_ID=...        # developer.paypal.com → Apps & Credentials → Sandbox
export PAYPAL_CLIENT_SECRET=...
export PAYPAL_ENV=sandbox
export ANTHROPIC_API_KEY=...       # optional, enables Claude
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
public/         dashboard (AG Grid order grid, vanilla JS)
test/           node:test suite
```

## Built with

PayPal Vault v3, Orders v2 and Payments v2 (sandbox) · Anthropic Claude (tool use) · AG Grid Community · Node.js and Express · Render

## Licence

MIT. See [LICENSE](LICENSE).
