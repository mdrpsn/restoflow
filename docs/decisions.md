# Decisions

Chronological, most recent first. Each entry is the decision + the actual reason, not just
the outcome — so a later reader can tell whether the reasoning still holds before
reversing something.

## Carry Supplier + Minimum Stock into Ingredient as defaults (2026-09-14)

The source `Ingredients List.xlsx` (see the seed script (`prisma/seed.ts`)) already had `Supplier` and
`Minimum Stock` columns per ingredient, but the original migration only used `Supplier`
to build the `Supplier` table itself — the per-ingredient link, and the threshold, were
dropped. Added `Ingredient.defaultSupplierId` (nullable FK → `Supplier`) and
`Ingredient.defaultLowStockAt` (nullable), both seeded from the same source columns.
This is not new data — it's finishing a migration that was already half-done.

Deliberately **not** a substitute for real `StockItem.lowStockAt`: that stays the real,
per-branch, opening-count-derived value once real counts exist (see the existing
"why StockItem isn't seeded" reasoning below). `defaultLowStockAt` only exists so that
whenever a real `StockItem` row does get created for a branch+ingredient, there's a sane
non-zero threshold to pre-fill from instead of defaulting to 0. Only 717 of 894
ingredients had a usable (positive, numeric) source value; the rest are left null rather
than guessed.

Same pass fixed a latent bug in `seed.ts`: `StockRequestLine`/`StockRequest` were never
added to the wipe order when `StockRequest` was introduced (20260906115730), so
`ingredient.deleteMany()` failed with a foreign-key violation once real `StockRequest`
rows existed. Fixed by deleting `StockRequestLine`/`StockRequest` before `Ingredient` in
the reseed sequence.

## Restoflow replaces Loyverse as the POS (2026-09-06)

The business's real pain point: no visibility into low/critical stock across branches
(no reorder trigger), and no way to catch ingredient theft/wastage. The plan had been
Loyverse (free tier) for POS + a lightweight custom webapp digitizing paper shift-report
forms for reconciliation, on the reasoning that rebuilding a POS from scratch (payments,
receipt printing, hardware) wasn't worth it when Loyverse already gives that away free.

That reasoning changed once this Restoflow project was found already sitting in the
Projects folder — a **full POS with a working checkout already built and already
pilot-tested** (the private pilot log, status: GO), plus the exact recipe-based
BOM deduction + variance/waste reporting engine the business actually needed. Since the
checkout module was already sunk cost, working, and tested — not hypothetical future
work — the calculus flipped: adopt Restoflow as the real POS rather than build a second,
narrower system next to Loyverse.

**Trade-off accepted knowingly**: Restoflow has only been pilot-tested at small scale,
not battle-hardened at Loyverse's level (offline resilience, hardware integrations,
multi-device concurrency at a busy counter). Recommended mitigation: don't hard-cut all
branches at once — finish the Loyverse item import as a working fallback, pilot Restoflow
at one real branch, cut over branch-by-branch once proven.

## Product has no size/variant field — one row per size (carried from Loyverse work)

`Product.priceCents` is flat; there's no `Option`/variant concept like Loyverse's
Handle+Option model. Rather than add one (bigger schema change, affects `SaleLine`,
`RecipeLine`, reporting), each size tier is its own `Product` row (e.g. "Takobits
(Solo)", "Takobits (Family)"), matching how the Loyverse CSV was already structured. See
the seed script (`prisma/seed.ts`) for the actual seeded data.

## Don't fabricate demo data on top of real names (2026-09-06)

The original seed script demonstrated the full lifecycle (a transfer, a waste log, a PO)
using invented ingredients (burger bun, beef patty). Once real branch/product/ingredient
names replaced the demo ones, continuing that pattern — inventing a fake transfer or
waste event and attaching it to a real ingredient name — would read as fabricated
business history rather than obviously-fake demo data. Left `StockItem`/`Sale`/
`StockTransfer`/`PurchaseOrder` empty instead; see the seed script (`prisma/seed.ts`)'s table.
