# Mandate design system

Mandate moves money on someone's behalf, so the interface has one job: make it obvious, at a glance, **what an agent did, why it was allowed, and how to undo it**.

## Principles

1. **State is colour, and colour is state.** Each semantic colour means one thing everywhere: in the grid, the receipt, the meter, the toasts and the inbox.
2. **Every automatic action is reversible from where you see it.** A payment the agent makes shows an Undo, with its countdown, in a toast, in the grid row and in the order.
3. **Explain before asking.** Anything that waits for a human shows the rule that stopped it ("Mailer box S went up 6.9% since your last order. Your limit is 5%.").
4. **Nothing irreversible without a confirm step.** Stop all agents says how many payments on hold it will cancel, and for how much, before it runs.
5. **The model proposes, code decides.** The interface never shows an AI decision as final; it shows the mandate engine's receipt.

## Tokens

| Token | Light | Dark | Meaning |
| --- | --- | --- | --- |
| `--primary` | `#0a5cff` | `#6d9bff` | Actions, links, focus |
| `--ok` | `#0b7a46` | `#4cc98a` | Paid, rule passed |
| `--warn` | `#a64d00` | `#f3b25c` | Waiting for you |
| `--bad` | `#c8291f` | `#ff7f73` | Blocked, stop, destructive |
| `--hold` | `#5a3fd8` | `#a898ff` | Money on hold in PayPal, can undo |
| `--ink` / `--ink-2` / `--ink-3` | `#0b1b3f` / `#44546f` / `#6b7a94` | `#e8edf6` / `#b2bdd0` / `#8794ab` | Text |
| `--bg` / `--surface` / `--line` | `#f4f6fa` / `#fff` / `#e3e8f0` | `#0a0f1c` / `#111827` / `#1f2a3d` | Structure |

**Type:** Inter for everything, with tabular figures for money. Scale: 12 / 13 / 14 / 15 / 18 / 28 / 30 px. Monospace is used only for PayPal reference IDs.

**Space and shape:** 8px grid (8, 12, 16, 20, 24, 32). Cards have a 16px radius, controls are pill-shaped, and inputs have an 8px radius. Cards get a hairline border and a soft shadow. Only "Waiting for you" gets a coloured border, because it is the only card that needs action.

**Words:** plain English for a non-technical buyer. "On hold" not "authorized", "Undone" not "voided", "Waiting for you" not "needs approval", and item names, never SKU codes.

## Components

| Component | Where | Notes |
| --- | --- | --- |
| Status badge | Grid, drawer | `On hold · undo 45s`, `Paid`, `Waiting for you`, `Blocked`, `Undone`, `Refunded`, `Declined` |
| Payment drawer | Click any payment | Verdict, the rules that decided it, passed rules folded away, the agent's reason, items, PayPal references |
| Undo toast | Bottom right | One per agent payment, live countdown, disappears at capture |
| Waiting for you | Under the agent | Only rendered when something waits; "See why" opens the receipt |
| Stop all agents | Header | Confirmation dialog states how many payments on hold get cancelled, and for how much; Esc cancels |
| Guided tour | Header and welcome card | 7 steps with a spotlight on each part of the screen; Esc or Skip ends it |
| Rules editor | Your rules → Edit | Plain English → preview of changes (now / after) → Apply; numbers editable under "Or set the numbers yourself" |
| Welcome card | Top | One sentence of value, the 3 steps with live progress, tour button; hides when done or dismissed |

## Accessibility

- Visible focus ring on every control (`:focus-visible`), native buttons and inputs throughout.
- Live regions for notices, the agent trace and the parse status.
- The kill confirmation is a labelled `alertdialog`, gets focus on open, and returns focus on cancel.
- Works at 400px wide; respects `prefers-reduced-motion` and `prefers-color-scheme`.
