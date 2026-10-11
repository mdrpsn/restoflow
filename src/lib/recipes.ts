import { Prisma, type PrismaClient } from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";

type Tx = Prisma.TransactionClient | PrismaClient;

export type RecipeLineInput = { ingredientId: string; quantity: number; sweetnessPercent?: number | null };

/**
 * A recipe line with no sweetnessPercent is consumed on every sale. One that has
 * a value (e.g. fructose at 75%) is consumed only when the sale line picked that
 * Sweetness Level. Shared by sale deduction, void restore and food-cost reports
 * so they can never disagree about which lines applied.
 */
export function recipeLineApplies(
  line: { sweetnessPercent?: number | null },
  sweetness: number | null | undefined,
): boolean {
  return line.sweetnessPercent == null || line.sweetnessPercent === sweetness;
}

/**
 * Aggregates theoretical ingredient consumption for a set of (recipe, quantity sold) pairs.
 * This is the exact math completeSale() uses to deduct stock — reused here so sale-time
 * deduction and after-the-fact reporting can never disagree.
 */
export function aggregateTheoreticalConsumption(
  lines: {
    recipeLines: { ingredientId: string; quantity: Decimal; sweetnessPercent?: number | null }[];
    quantitySold: number;
    sweetnessPercent?: number | null;
  }[],
): Map<string, Decimal> {
  const needs = new Map<string, Decimal>();
  for (const line of lines) {
    for (const recipe of line.recipeLines) {
      if (!recipeLineApplies(recipe, line.sweetnessPercent)) continue;
      const add = new Decimal(recipe.quantity).mul(line.quantitySold);
      const prev = needs.get(recipe.ingredientId) ?? new Decimal(0);
      needs.set(recipe.ingredientId, prev.plus(add));
    }
  }
  return needs;
}

/**
 * Replaces a product's active recipe with a new version: deactivates the current
 * active lines (if any) and inserts the new ones one version higher. Never deletes
 * history, so past SaleLine.recipeVersion snapshots stay reconstructable.
 */
export async function setProductRecipe(tx: Tx, productId: string, lines: RecipeLineInput[]) {
  const currentMax = await tx.recipeLine.aggregate({
    where: { productId },
    _max: { version: true },
  });
  const nextVersion = (currentMax._max.version ?? 0) + 1;

  await tx.recipeLine.updateMany({
    where: { productId, isActive: true },
    data: { isActive: false },
  });

  if (lines.length) {
    await tx.recipeLine.createMany({
      data: lines.map((l) => ({
        productId,
        ingredientId: l.ingredientId,
        quantity: new Decimal(l.quantity),
        sweetnessPercent: l.sweetnessPercent ?? null,
        version: nextVersion,
        isActive: true,
      })),
    });
  }

  return nextVersion;
}
