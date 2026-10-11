import { ProductsClient } from "@/components/products-client";
import { prisma } from "@/lib/prisma";
import { requireManager } from "@/lib/session";
import { computeRecipeCostCents, referenceSweetness } from "@/lib/costing";

export default async function ProductsPage() {
  const user = await requireManager();
  const [products, ingredients] = await Promise.all([
    prisma.product.findMany({
      where: { organizationId: user.organizationId },
      include: {
        recipeLines: { where: { isActive: true }, include: { ingredient: true } },
        channelPrices: true,
      },
      orderBy: { name: "asc" },
    }),
    prisma.ingredient.findMany({
      where: { organizationId: user.organizationId },
      orderBy: { name: "asc" },
    }),
  ]);
  const ingredientCostMap = new Map(ingredients.map((i) => [i.id, i.costCentsPerUnit]));

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Products & recipes</h1>
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          Sellable items with bill-of-materials for inventory deduct.
        </p>
      </div>
      <ProductsClient
        ingredients={ingredients.map((i) => ({
          id: i.id,
          name: i.name,
          unit: i.unit,
          costCentsPerUnit: i.costCentsPerUnit,
        }))}
        products={products.map((p) => {
          const theoreticalCostCents = computeRecipeCostCents(
            p.recipeLines,
            ingredientCostMap,
            referenceSweetness(p.recipeLines),
          );
          return {
            id: p.id,
            name: p.name,
            sku: p.sku,
            priceCents: p.priceCents,
            imageUrl: p.imageUrl,
            foodpandaPriceCents: p.channelPrices.find((cp) => cp.channel === "FOODPANDA")?.priceCents ?? null,
            grabfoodPriceCents: p.channelPrices.find((cp) => cp.channel === "GRABFOOD")?.priceCents ?? null,
            active: p.active,
            theoreticalCostCents,
            recipeLines: p.recipeLines
              .filter((r) => r.sweetnessPercent === null)
              .map((r) => ({ ingredientId: r.ingredientId, quantity: Number(r.quantity.toString()) })),
            sweetnessLines: p.recipeLines
              .filter((r) => r.sweetnessPercent !== null)
              .map((r) => ({
                ingredientId: r.ingredientId,
                quantity: Number(r.quantity.toString()),
                sweetnessPercent: r.sweetnessPercent as number,
              })),
          };
        })}
      />
    </div>
  );
}
