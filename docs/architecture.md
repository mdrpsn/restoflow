# Architecture

Stack: Next.js (App Router) + TypeScript + Tailwind, PostgreSQL + Prisma, Auth.js
(credentials sessions, stateless JWT). Full model list is `prisma/schema.prisma` — this
note is the map, not a restatement of it.

## Core data flow

`Organization` → `Branch` (a `Branch` with `type: WAREHOUSE` is just a branch that can't
sell — POS is hidden for it, it can still be a transfer endpoint) → `Product` (flat
name + `priceCents`, **no built-in size/variant concept** — a "Takobits Solo" and
"Takobits Family" are two separate `Product` rows, not one product with variants) →
`RecipeLine` (versioned BOM: editing a recipe creates a new version rather than
overwriting it, so a `SaleLine` keeps `recipeVersion` and old sales stay tied to the
recipe actually in effect when they happened) → `Ingredient` → `StockItem` (current
on-hand + `lowStockAt` threshold, one row per branch+ingredient) → `StockMovement`
(append-only ledger; every stock change of any kind — sale, receive, transfer, waste,
adjustment — goes through `applyMovement` in `src/lib/stock.ts`, advisory-locked per
branch/ingredient so concurrent writes can't race).

Money is always integer cents. Quantities are Prisma `Decimal`.

## n8n integration boundary

Restoflow remains the only writer of sales and stock. Inventory state changes enqueue an
`IntegrationEvent` in the same database transaction as the stock movement; n8n polls and
acknowledges that outbox through bearer-token-protected routes. Replenishment automation
creates an editable `DRAFT` request calculated from `StockItem.lowStockAt` and `parLevel`.
A manager must submit it before the existing warehouse approval and transfer lifecycle
can move inventory. See [[n8n-pilot]] for deployment and workflow configuration.

## Why this shape matters for the current migration

The whole point of adopting Restoflow (see [[decisions]]) is that a `Sale` automatically
walks its `Product`'s active `RecipeLine`s and deducts the right `Ingredient` quantities
via `applyMovement` — that's the theft/waste detection mechanism: compare what
should have been consumed (recipe × sales) against what actually was (stock counts,
`StockMovement` ledger). **Without `RecipeLine` data, sales don't deduct anything** —
see the seed script (`prisma/seed.ts`) for what's seeded and what isn't yet.

## Route groups (`src/app`)

`(app)/pos`, `(app)/inventory`, `(app)/catalog`, `(app)/purchasing`, `(app)/transfers`,
`(app)/reports`, `(app)/admin` — one route group per feature area, all behind auth.
Active branch is chosen in the header and scoped via cookie, re-derived server-side on
every request (see `src/lib/branch.ts`'s `getActiveBranchId`/`requireActiveBranch`, and
`canAccessBranch` in `src/lib/rbac.ts` for authorization).

## Known sharp edges

Server authentication treats the JWT as proof of identity and reloads current account
access from PostgreSQL. A session version revokes old tokens when a password is reset
or an account is deactivated. Edge middleware only gates navigation; server guards
remain authoritative. Account edits are serialized per organization.

QR orders follow `PENDING → CLAIMED → COMPLETED`, with a return path to `PENDING` and
cancellation from `PENDING`. Claim, release, cancellation and checkout lock the same
order row. Checkout links one sale and its stock deduction atomically; retries return
the linked sale. See [[known-issues]] for legacy claims and recovery limitations.
