import { RequestsClient } from "@/components/requests-client";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/session";
import { requireActiveBranch, listAccessibleBranches } from "@/lib/branch";
import { isManagerOrAbove, isWarehouseAdmin } from "@/lib/rbac";

export default async function RequestsPage() {
  const user = await requireSession();
  const branch = await requireActiveBranch(user);
  const accessibleBranches = await listAccessibleBranches(user);
  const isWhAdmin = isWarehouseAdmin(user.role, accessibleBranches);

  const [ingredients, myRequests, incomingRequests] = await Promise.all([
    prisma.ingredient.findMany({
      where: { organizationId: user.organizationId },
      select: { id: true, name: true, unit: true },
      orderBy: { name: "asc" },
    }),
    prisma.stockRequest.findMany({
      where: { branchId: branch.id },
      include: { lines: { include: { ingredient: true } }, requestedBy: true },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
    isWhAdmin
      ? prisma.stockRequest.findMany({
          where: { organizationId: user.organizationId, status: "PENDING" },
          include: { lines: { include: { ingredient: true } }, requestedBy: true, branch: true },
          orderBy: { createdAt: "asc" },
        })
      : Promise.resolve([]),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Stock requests</h1>
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          Ask the warehouse for stock — no inventory numbers here, just what you need.
        </p>
      </div>
      <RequestsClient
        canRequest={branch.type !== "WAREHOUSE"}
        branchName={branch.name}
        isWhAdmin={isWhAdmin}
        canSubmitDraft={isManagerOrAbove(user.role)}
        ingredients={ingredients}
        myRequests={myRequests.map((r) => ({
          id: r.id,
          status: r.status,
          source: r.source,
          note: r.note,
          rejectionReason: r.rejectionReason,
          createdAt: r.createdAt.toISOString(),
          reviewedAt: r.reviewedAt?.toISOString() ?? null,
          requestedByName: r.requestedBy?.name ?? "Restoflow automation",
          lines: r.lines.map((l) => ({
            id: l.id,
            ingredientId: l.ingredientId,
            ingredientName: l.ingredient.name,
            unit: l.ingredient.unit,
            quantity: l.quantity.toString(),
            approvedQuantity: l.approvedQuantity?.toString() ?? null,
          })),
        }))}
        incomingRequests={incomingRequests.map((r) => ({
          id: r.id,
          note: r.note,
          createdAt: r.createdAt.toISOString(),
          branchName: r.branch.name,
          requestedByName: r.requestedBy?.name ?? "Restoflow automation",
          lines: r.lines.map((l) => ({
            id: l.id,
            ingredientId: l.ingredientId,
            ingredientName: l.ingredient.name,
            unit: l.ingredient.unit,
            quantity: l.quantity.toString(),
          })),
        }))}
      />
    </div>
  );
}
