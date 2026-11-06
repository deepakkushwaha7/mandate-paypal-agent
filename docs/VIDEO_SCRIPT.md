# Demo video script (target 2:40, hard limit 3:00)

Record the screen at 1440×900 or larger, with the browser zoomed to 110%. Click **Reset demo** first. Use the real PayPal sandbox and Claude if they're configured, so the header pills read "PayPal: sandbox" and the Claude model name. No music, or royalty-free music only.

| Time | On screen | Voice-over |
| --- | --- | --- |
| 0:00–0:15 | Dashboard, slow scroll | "Every brand runs out of boxes and labels. An AI agent could reorder them, but would you give it your company card? Mandate lets an agent pay suppliers through PayPal, only inside limits you set, and every payment can be undone." |
| 0:15–0:40 | Spending mandate card → click **Save PayPal for the agent** → PayPal approval → back | "First, the buyer grants a mandate once. They save PayPal for the agent using PayPal Vault and set the rules: €2,500 a month, auto-pay below €400, only these suppliers and categories, and no supplier price rises above 5%." |
| 0:40–1:10 | Type "Black Friday campaign starts in 2 weeks" → **Run reorder check** → agent steps stream in | "Now the agent. Claude reads stock cover and lead times, takes my instruction about Black Friday, and proposes one order per supplier. It never sets prices. A mandate engine in code prices every proposal and returns a verdict the agent has to respect." |
| 1:10–1:35 | Point at the three outcomes in the steps and the grid | "Three outcomes. Tissue paper is in policy, so the agent pays on its own through a PayPal authorization against the saved account. Boxes need me: the supplier quietly raised its price 6.9%. Canvas totes are blocked, because that supplier isn't in my mandate. The agent reports it and doesn't try to get around it." |
| 1:35–1:55 | Click **Undo · 45s** on the auto-paid order → status "Undone", audit log shows the void | "Every agent payment has an undo window. Undo voids the PayPal authorization and no money moves. After the window it's captured, and Undo becomes a refund." |
| 1:55–2:20 | Click the boxes order → detail shows reasons → **Approve in PayPal** → sandbox approval → back to "Held · undo" | "For exceptions I see exactly why, and approve in PayPal with one click. Approval re-checks the caps at that moment, so a stale proposal can't push me over budget." |
| 2:20–2:40 | Audit log, then the README API table | "Everything is in the audit log with PayPal IDs. Under the hood: PayPal Vault, Orders v2 with authorize, and Payments v2 for capture, void and refund, plus Claude tool use and AG Grid. Mandate: let agents buy, on your terms." |

Upload to YouTube as **Public**, titled "Mandate: AI agent payments with PayPal spending mandates and undo".
