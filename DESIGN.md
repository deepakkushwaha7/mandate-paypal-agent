# Mandate design system

Mandate moves money on someone's behalf, so the interface has one job: make it obvious, at a glance, **what an agent did, why it was allowed, and how to undo it**.

## Principles

1. **State is colour, and colour is state.** Each semantic colour means one thing everywhere: in the grid, the receipt, the meter, the toasts and the inbox.
2. **Every automatic action is reversible from where you see it.** A payment the agent makes shows an Undo, with its countdown, in a toast, in the grid row and in the order.
3. **Explain before asking.** Anything that waits for a human shows the rule that stopped it ("Price rise within 5%: MBX-S-KRAFT rose 6.9%").
4. **Nothing irreversible without a confirm step.** The kill switch says how many PayPal authorizations it will void and for how much before it runs.
5. **The model proposes, code decides.** The interface never shows an AI decision as final; it shows the mandate engine's receipt.

## Tokens

| Token | Light | Dark | Meaning |
| --- | --- | --- | --- |
| `--accent` | `#2448d8` | `#7f9cff` | Actions, links, focus |
| `--ok` | `#0d7a46` | `#4cc987` | Paid, rule passed |
| `--warn` | `#a14f05` | `#f1b25a` | Needs a human |
| `--bad` | `#c0291b` | `#ff7e70` | Blocked, stop, destructive |
| `--held` | `#5b3fd6` | `#a897ff` | Money held by PayPal, undo open |
| `--ink` / `--muted` | `#0f172a` / `#536079` | `#e7ebf2` / `#96a2b6` | Text |
| `--bg` / `--surface` / `--line` | `#f4f6f9` / `#fff` / `#e2e6ed` | `#0a0e16` / `#121823` / `#232c3b` | Structure |

Each colour has a `-soft` background pair. Every text and background pair passes **WCAG AA (≥ 4.5:1)** in both themes. The lowest is 4.8:1 (`--ok` on `--ok-soft`, light). Text on solid buttons uses `--on-solid`, which flips to dark in dark mode so red and green buttons stay readable.

**Type:** Instrument Sans for interface text, JetBrains Mono for money, IDs and codes, with tabular figures so amounts line up.

**Shape:** 12px card radius, 8px controls, 99px pills. Cards get a hairline border and a soft shadow. Only the approval inbox gets a coloured border, because it is the only thing waiting on you.

## Components

| Component | Where | Notes |
| --- | --- | --- |
| Status pill | Grid, receipt header | `Held · undo`, `Paid`, `Needs you`, `Blocked`, `Undone`, `Refunded` |
| Decision receipt | Order detail | 14 rules, each ✓ / ! / ✕, with mandate version, agent and the agent's reason |
| Undo toast | Bottom right | One per agent payment, live countdown, disappears at capture |
| Approval inbox | Above the grid | Only rendered when something waits; "Why?" opens the receipt |
| Kill switch | Header | Two-step: states the impact, then confirms; Esc cancels |
| Mandate editor | Mandate card | Plain English → preview of changes (before/after) → Apply |
| First-run steps | Below header | Save PayPal → Check mandate → Run agent; hides when done |

## Accessibility

- Visible focus ring on every control (`:focus-visible`), native buttons and inputs throughout.
- Live regions for notices, the agent trace and the parse status.
- The kill confirmation is a labelled `alertdialog`, gets focus on open, and returns focus on cancel.
- Works at 400px wide; respects `prefers-reduced-motion` and `prefers-color-scheme`.
