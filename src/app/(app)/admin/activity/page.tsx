import { prisma } from "@/lib/prisma";
import { requireOwner } from "@/lib/session";
import { getStockMovementLedger } from "@/lib/reports";
import { resolveReportFilters } from "@/lib/reportFilters";
import { ReportFilterBar } from "@/components/report-filter-bar";

export default async function ActivityLogPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string; branchId?: string }>;
}) {
  const user = await requireOwner();
  const params = await searchParams;
  const { days, branches, branchId, since, branchIds } = await resolveReportFilters(user, params);

  const [movements, transfers, purchaseOrders] = await Promise.all([
    getStockMovementLedger({ branchIds, range: { since }, limit: 100 }),
    prisma.stockTransfer.findMany({
      where: { fromBranch: { organizationId: user.organizationId }, createdAt: { gte: since } },
      include: {
        fromBranch: true,
        toBranch: true,
        createdBy: true,
        shippedBy: true,
        receivedBy: true,
        cancelledBy: true,
      },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
    prisma.purchaseOrder.findMany({
      where: { organizationId: user.organizationId, createdAt: { gte: since } },
      include: { branch: true, supplier: true, createdBy: true, cancelledBy: true },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
  ]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Activity log</h1>
          <p className="text-sm" style={{ color: "var(--muted)" }}>
            Who did what, org-wide. Last {days} days.
          </p>
        </div>
        <ReportFilterBar days={days} branches={branches} branchId={branchId} role={user.role} />
      </div>

      <div className="panel overflow-x-auto p-4">
        <h2 className="mb-2 font-semibold">Stock ledger activity</h2>
        <table className="table">
          <thead>
            <tr>
              <th>When</th>
              <th>Branch</th>
              <th>Type</th>
              <th>Ingredient</th>
              <th>Δ</th>
              <th>By</th>
              <th>Note</th>
            </tr>
          </thead>
          <tbody>
            {movements.map((m) => (
              <tr key={m.id}>
                <td className="whitespace-nowrap text-xs">{m.createdAt.toLocaleString()}</td>
                <td>{m.branch.code}</td>
                <td className="text-xs">{m.type}</td>
                <td>{m.ingredient.name}</td>
                <td>{m.quantity.toString()}</td>
                <td className="text-xs">{m.createdBy?.name ?? "—"}</td>
                <td className="text-xs">{m.note ?? "—"}</td>
              </tr>
            ))}
            {movements.length === 0 && (
              <tr>
                <td colSpan={7} style={{ color: "var(--muted)" }}>
                  No stock activity in range
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="panel overflow-x-auto p-4">
        <h2 className="mb-2 font-semibold">Transfers</h2>
        <p className="mb-3 text-xs" style={{ color: "var(--muted)" }}>
          Creation and cancellation don&apos;t always move stock, so they don&apos;t appear in the
          ledger above — shown here instead.
        </p>
        <table className="table">
          <thead>
            <tr>
              <th>Route</th>
              <th>Status</th>
              <th>Created</th>
              <th>Shipped</th>
              <th>Received</th>
              <th>Cancelled</th>
            </tr>
          </thead>
          <tbody>
            {transfers.map((t) => (
              <tr key={t.id}>
                <td>
                  {t.fromBranch.code} → {t.toBranch.code}
                </td>
                <td className="text-xs">{t.status}</td>
                <td className="text-xs">
                  {t.createdAt.toLocaleString()}
                  {t.createdBy ? ` · ${t.createdBy.name}` : ""}
                </td>
                <td className="text-xs">
                  {t.shippedAt ? t.shippedAt.toLocaleString() : "—"}
                  {t.shippedBy ? ` · ${t.shippedBy.name}` : ""}
                </td>
                <td className="text-xs">
                  {t.receivedAt ? t.receivedAt.toLocaleString() : "—"}
                  {t.receivedBy ? ` · ${t.receivedBy.name}` : ""}
                </td>
                <td className="text-xs">
                  {t.cancelledAt ? t.cancelledAt.toLocaleString() : "—"}
                  {t.cancelledBy ? ` · ${t.cancelledBy.name}` : ""}
                </td>
              </tr>
            ))}
            {transfers.length === 0 && (
              <tr>
                <td colSpan={6} style={{ color: "var(--muted)" }}>
                  No transfers in range
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="panel overflow-x-auto p-4">
        <h2 className="mb-2 font-semibold">Purchase orders</h2>
        <table className="table">
          <thead>
            <tr>
              <th>Branch</th>
              <th>Supplier</th>
              <th>Status</th>
              <th>Created</th>
              <th>Cancelled</th>
            </tr>
          </thead>
          <tbody>
            {purchaseOrders.map((po) => (
              <tr key={po.id}>
                <td>{po.branch.code}</td>
                <td>{po.supplier.name}</td>
                <td className="text-xs">{po.status}</td>
                <td className="text-xs">
                  {po.createdAt.toLocaleString()}
                  {po.createdBy ? ` · ${po.createdBy.name}` : ""}
                </td>
                <td className="text-xs">
                  {po.cancelledAt ? po.cancelledAt.toLocaleString() : "—"}
                  {po.cancelledBy ? ` · ${po.cancelledBy.name}` : ""}
                </td>
              </tr>
            ))}
            {purchaseOrders.length === 0 && (
              <tr>
                <td colSpan={5} style={{ color: "var(--muted)" }}>
                  No purchase orders in range
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
