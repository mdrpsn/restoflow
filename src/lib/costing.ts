import { Decimal } from "@prisma/client/runtime/library";

export type CostableRecipeLine = {
  ingredientId: string;
  quantity: Decimal | number | string;
  sweetnessPercent?: number | null;
};

/**
 * The sweetness level to price a product at when there's no actual sale to go
 * by (catalog cost estimate): 100% if the recipe has sweetness-dependent lines
 * for it, else the highest level present, else null (no dependent lines).
 */
export function referenceSweetness(lines: { sweetnessPercent?: number | null }[]): number | null {
  const levels = lines.map((l) => l.sweetnessPercent).filter((v): v is number => v != null);
  if (levels.length === 0) return null;
  return levels.includes(100) ? 100 : Math.max(...levels);
}

export type IngredientCostMap = Map<string, number>;

/**
 * Theoretical cost in cents to make one unit of a product, given its recipe lines.
 * Sweetness-dependent lines count only when they match `sweetness` (the level
 * actually sold, or referenceSweetness() for an estimate).
 */
export function computeRecipeCostCents(
  lines: CostableRecipeLine[],
  ingredientCostCentsPerUnit: IngredientCostMap,
  sweetness: number | null = null,
): number {
  return lines.reduce((sum, line) => {
    if (line.sweetnessPercent != null && line.sweetnessPercent !== sweetness) return sum;
    const costPerUnit = ingredientCostCentsPerUnit.get(line.ingredientId) ?? 0;
    const qty = Number(new Decimal(line.quantity).toString());
    return sum + costPerUnit * qty;
  }, 0);
}

/** Food cost % = cost of goods / revenue, as a 0-100 number. Returns null if revenue is 0. */
export function computeFoodCostPercent(costCents: number, revenueCents: number): number | null {
  if (revenueCents <= 0) return null;
  return (costCents / revenueCents) * 100;
}
