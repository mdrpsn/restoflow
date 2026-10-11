/**
 * Ingredient packs. Stock is held, deducted and reported in the ingredient's base unit (g, ml,
 * pcs...). A pack ("430g bar", "1000ml bottle") is only a way to type a quantity in or to
 * describe one, worth `size` base units. Pure functions: safe to import from client components.
 */

export type PackInfo = { name: string; size: number; isDefault?: boolean };

const UNIT_SCALE = 1000; // packs can be fractional (1.25 l); compare on a 1/1000 grid

export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  const rounded = Math.round(n * 10000) / 10000;
  return rounded.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

export function formatQty(quantity: number, unit: string): string {
  return `${formatNumber(quantity)} ${unit}`;
}

/** Suggested pack name from its size, unit and an optional container word: "430g bar". */
export function defaultPackName(size: number, unit: string, container = "pack"): string {
  return `${formatNumber(size).replace(/,/g, "")}${unit} ${container}`;
}

/**
 * Describes `quantity` as a whole number of packs when it splits exactly ("3 × 430g bar",
 * "1 × 900g bar + 2 × 160g bar"), preferring fewer packs. Returns null when it doesn't split
 * exactly: callers then show the plain base-unit quantity rather than an ambiguous "1.5 bar".
 */
export function packBreakdown(quantity: number, packs: PackInfo[]): string | null {
  const target = Math.round(quantity * UNIT_SCALE);
  if (target <= 0 || packs.length === 0) return null;
  const sorted = packs
    .map((p) => ({ name: p.name, size: Math.round(p.size * UNIT_SCALE) }))
    .filter((p) => p.size > 0)
    .sort((a, b) => b.size - a.size);

  let best: { name: string; count: number }[] | null = null;
  let bestPacks = Infinity;

  function search(idx: number, remaining: number, picked: { name: string; count: number }[], total: number) {
    if (total >= bestPacks) return;
    if (remaining === 0) {
      best = picked.filter((p) => p.count > 0);
      bestPacks = total;
      return;
    }
    if (idx >= sorted.length) return;
    const { name, size } = sorted[idx];
    for (let count = Math.floor(remaining / size); count >= 0; count--) {
      search(idx + 1, remaining - count * size, [...picked, { name, count }], total + count);
    }
  }
  search(0, target, [], 0);

  if (!best) return null;
  return (best as { name: string; count: number }[]).map((p) => `${formatNumber(p.count)} × ${p.name}`).join(" + ");
}

/** "1,290 g (3 × 430g bar)" when it splits exactly into packs, else "645 g". */
export function formatStock(quantity: number, unit: string, packs: PackInfo[], showPacks: boolean): string {
  const base = formatQty(quantity, unit);
  if (!showPacks) return base;
  const hint = packBreakdown(quantity, packs);
  return hint ? `${base} (${hint})` : base;
}

/** Base-unit quantity for `packCount` of `pack`, on the same 1/1000 grid used for matching. */
export function packToBase(packCount: number, pack: PackInfo): number {
  return Math.round(packCount * pack.size * UNIT_SCALE) / UNIT_SCALE;
}
