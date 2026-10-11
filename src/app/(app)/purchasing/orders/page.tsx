import { OrdersClient } from "@/components/orders-client";
import { prisma } from "@/lib/prisma";
import { requireManager } from "@/lib/session";
import { requireActiveBranch } from "@/lib/branch";

export default async function OrdersPage() {
  const user = await requireManager();
  const branch = await requireActiveBranch(user);

  const [suppliers, ingredients, orders] = await Promise.all([
    prisma.supplier.findMany({
      where: { organizationId: user.organizationId, active: true },
      orderBy: { name: "asc" },
    }),
    prisma.ingredient.findMany({
      where: { organizationId: user.organizationId },
      orderBy: { name: "asc" },
    }),
    prisma.purchaseOrder.findMany({
      where: { organizationId: user.organizationId },
      include: {
        supplier: true,
        branch: true,
        lines: { include: { ingredient: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 30,
    }),
  ]);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Purchase orders</h1>
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          Create and receive POs into the active branch ({branch.name}).
        </p>
      </div>
      <OrdersClient
        branchName={branch.name}
        suppliers={suppliers.map((s) => ({ id: s.id, name: s.name }))}
        ingredients={ingredients.map((i) => ({
          id: i.id,
          name: i.name,
          unit: i.unit,
          costCentsPerUnit: i.costCentsPerUnit,
        }))}
        orders={orders.map((o) => ({
          id: o.id,
          status: o.status,
          supplierName: o.supplier.name,
          branchName: o.branch.name,
          note: o.note,
          createdAt: o.createdAt.toISOString(),
          lines: o.lines.map((l) => ({
            id: l.id,
            ingredientId: l.ingredientId,
            ingredientName: l.ingredient.name,
            unit: l.ingredient.unit,
            quantityOrdered: l.quantityOrdered.toString(),
            quantityReceived: l.quantityReceived.toString(),
            unitCostCents: l.unitCostCents,
          })),
        }))}
      />
    </div>
  );
}
