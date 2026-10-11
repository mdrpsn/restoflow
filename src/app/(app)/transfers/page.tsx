import { TransfersClient } from "@/components/transfers-client";
import { prisma } from "@/lib/prisma";
import { requireWarehouseAdmin } from "@/lib/session";
import { requireActiveBranch } from "@/lib/branch";

export default async function TransfersPage() {
  const user = await requireWarehouseAdmin();
  const branch = await requireActiveBranch(user);

  const [branches, ingredients, transfers] = await Promise.all([
    prisma.branch.findMany({
      where: { organizationId: user.organizationId },
      orderBy: { name: "asc" },
    }),
    prisma.ingredient.findMany({
      where: { organizationId: user.organizationId },
      include: { packs: { orderBy: { size: "asc" } } },
      orderBy: { name: "asc" },
    }),
    prisma.stockTransfer.findMany({
      where: { fromBranch: { organizationId: user.organizationId } },
      include: {
        fromBranch: true,
        toBranch: true,
        lines: { include: { ingredient: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 30,
    }),
  ]);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Stock transfers</h1>
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          Create transfers from the active branch ({branch.name}), then ship and receive them —
          stock only moves at those steps.
        </p>
      </div>
      <TransfersClient
        branchId={branch.id}
        branchName={branch.name}
        branches={branches.map((b) => ({ id: b.id, name: b.name, code: b.code, type: b.type }))}
        ingredients={ingredients.map((i) => ({
          id: i.id,
          name: i.name,
          unit: i.unit,
          packs: i.packs.map((p) => ({ id: p.id, name: p.name, size: Number(p.size), isDefault: p.isDefault })),
        }))}
        transfers={transfers.map((t) => ({
          id: t.id,
          status: t.status,
          fromBranchName: t.fromBranch.name,
          fromBranchId: t.fromBranchId,
          toBranchName: t.toBranch.name,
          toBranchId: t.toBranchId,
          note: t.note,
          createdAt: t.createdAt.toISOString(),
          shippedAt: t.shippedAt?.toISOString() ?? null,
          receivedAt: t.receivedAt?.toISOString() ?? null,
          cancelledAt: t.cancelledAt?.toISOString() ?? null,
          lines: t.lines.map((l) => ({
            id: l.id,
            ingredientName: l.ingredient.name,
            unit: l.ingredient.unit,
            quantity: l.quantity.toString(),
            packLabel: l.packLabel,
            packQuantity: l.packQuantity?.toString() ?? null,
          })),
        }))}
      />
    </div>
  );
}
