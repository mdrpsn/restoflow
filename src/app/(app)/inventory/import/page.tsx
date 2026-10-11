import { prisma } from "@/lib/prisma";
import { requireWarehouseAdmin } from "@/lib/session";
import { requireActiveBranch } from "@/lib/branch";
import { listRecentImports } from "@/lib/warehouseImport";
import { WarehouseImportClient } from "@/components/warehouse-import-client";

export default async function WarehouseImportPage() {
  const user = await requireWarehouseAdmin();
  const branch = await requireActiveBranch(user);

  const [ingredients, recent] = await Promise.all([
    prisma.ingredient.findMany({
      where: { organizationId: user.organizationId },
      orderBy: { name: "asc" },
      select: { id: true, name: true, unit: true },
    }),
    listRecentImports(branch.id),
  ]);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Import count sheet</h1>
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          Upload the daily Excel count for <strong>{branch.name}</strong>. You&apos;ll review exactly what
          will change before anything is saved.
        </p>
      </div>
      <WarehouseImportClient ingredients={ingredients} recent={recent} />
    </div>
  );
}
