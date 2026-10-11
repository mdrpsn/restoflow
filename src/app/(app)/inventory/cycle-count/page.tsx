import { prisma } from "@/lib/prisma";
import { requireWarehouseAdmin } from "@/lib/session";
import { requireActiveBranch } from "@/lib/branch";
import { CycleCountClient } from "@/components/cycle-count-client";
import { Decimal } from "@prisma/client/runtime/library";

export default async function CycleCountPage() {
  const user = await requireWarehouseAdmin();
  const branch = await requireActiveBranch(user);

  const [ingredients, stockItems] = await Promise.all([
    prisma.ingredient.findMany({
      where: { organizationId: user.organizationId },
      orderBy: { name: "asc" },
    }),
    prisma.stockItem.findMany({
      where: { branchId: branch.id },
    }),
  ]);

  const onHandByIngredient = new Map(stockItems.map((s) => [s.ingredientId, s.quantity]));

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Cycle count</h1>
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          Enter what you physically counted at <strong>{branch.name}</strong>. Anything left
          unchanged is skipped — only differences post an adjustment, all as one batch.
        </p>
      </div>
      <CycleCountClient
        ingredients={ingredients.map((i) => ({
          id: i.id,
          name: i.name,
          unit: i.unit,
          onHand: new Decimal(onHandByIngredient.get(i.id) ?? 0).toString(),
        }))}
      />
    </div>
  );
}
