import { PosClient } from "@/components/pos-client";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/session";
import { requireActiveBranch } from "@/lib/branch";
import { isManagerOrAbove } from "@/lib/rbac";
import { listUnavailableProductIds } from "@/lib/productAvailability";

export default async function PosPage() {
  const user = await requireSession();
  const branch = await requireActiveBranch(user);

  if (branch.type === "WAREHOUSE") {
    return (
      <div className="panel p-4">
        <p className="text-sm">
          <strong>{branch.name}</strong> is a warehouse and doesn&apos;t sell — switch to a
          store branch above to use POS.
        </p>
      </div>
    );
  }

  const [products, recentSales, unavailableIds] = await Promise.all([
    prisma.product.findMany({
      where: { organizationId: user.organizationId, active: true },
      orderBy: [{ category: "asc" }, { name: "asc" }],
      include: {
        channelPrices: true,
        modifierGroups: {
          where: { modifierGroup: { active: true } },
          orderBy: { modifierGroup: { sortOrder: "asc" } },
          include: {
            modifierGroup: {
              include: { modifiers: { where: { active: true }, orderBy: { sortOrder: "asc" } } },
            },
          },
        },
      },
    }),
    prisma.sale.findMany({
      where: { branchId: branch.id },
      include: { cashier: true },
      orderBy: { createdAt: "desc" },
      take: 12,
    }),
    listUnavailableProductIds(branch.id),
  ]);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Point of sale</h1>
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          Selling at <strong>{branch.name}</strong> — recipes deduct stock on complete.
        </p>
      </div>
      <PosClient
        key={branch.id}
        currentUserId={user.id}
        canOverrideStock={isManagerOrAbove(user.role)}
        canVoid={isManagerOrAbove(user.role)}
        products={products.map((p) => ({
          id: p.id,
          name: p.name,
          category: p.category,
          priceCents: p.priceCents,
          imageUrl: p.imageUrl,
          channelPrices: p.channelPrices.map((cp) => ({ channel: cp.channel, priceCents: cp.priceCents })),
          sku: p.sku,
          available: !unavailableIds.has(p.id),
          modifierGroups: p.modifierGroups.map((link) => ({
            id: link.modifierGroup.id,
            name: link.modifierGroup.name,
            selectionType: link.modifierGroup.selectionType,
            required: link.modifierGroup.required,
            modifiers: link.modifierGroup.modifiers.map((m) => ({
              id: m.id,
              name: m.name,
              priceCents: m.priceCents,
            })),
          })),
        }))}
        recentSales={recentSales.map((s) => ({
          id: s.id,
          totalCents: s.totalCents,
          paymentMethod: s.paymentMethod,
          channel: s.channel,
          externalRef: s.externalRef,
          createdAt: s.createdAt.toISOString(),
          status: s.status,
          cashierName: s.cashier.name,
        }))}
      />
    </div>
  );
}
