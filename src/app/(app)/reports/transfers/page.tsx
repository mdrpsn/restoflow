import { requireManager } from "@/lib/session";
import { getTransferActivity } from "@/lib/reports";
import { resolveReportFilters } from "@/lib/reportFilters";
import { ReportFilterBar } from "@/components/report-filter-bar";
import { ReportsNav } from "@/components/reports-nav";

export default async function TransferActivityReportPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string; branchId?: string }>;
}) {
  const user = await requireManager();
  const params = await searchParams;
  const { days, branches, branchId, since } = await resolveReportFilters(user, params);

  const activity = await getTransferActivity(user.organizationId, { since });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Transfer activity</h1>
        <ReportFilterBar days={days} branches={branches} branchId={branchId} role={user.role} />
      </div>
      <ReportsNav />

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="panel p-4">
          <h2 className="mb-2 font-semibold">By status ({activity.total} total)</h2>
          <table className="table">
            <thead>
              <tr>
                <th>Status</th>
                <th>Count</th>
              </tr>
            </thead>
            <tbody>
              {activity.byStatus.map((s) => (
                <tr key={s.status}>
                  <td>{s.status}</td>
                  <td>{s.count}</td>
                </tr>
              ))}
              {activity.byStatus.length === 0 && (
                <tr>
                  <td colSpan={2} style={{ color: "var(--muted)" }}>
                    No transfers in range
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="panel p-4">
          <div className="text-xs uppercase tracking-wide" style={{ color: "var(--muted)" }}>
            Avg. ship → receive time
          </div>
          <div className="text-2xl font-semibold">
            {activity.avgShipToReceiveHours === null
              ? "—"
              : `${activity.avgShipToReceiveHours.toFixed(1)}h`}
          </div>
        </div>
      </div>

      <div className="panel p-4">
        <h2 className="mb-2 font-semibold">
          Currently in transit ({activity.openInTransit.length})
        </h2>
        <table className="table">
          <thead>
            <tr>
              <th>Route</th>
              <th>Shipped</th>
              <th>Age</th>
            </tr>
          </thead>
          <tbody>
            {activity.openInTransit.map((t) => (
              <tr key={t.id}>
                <td>
                  {t.fromBranchName} → {t.toBranchName}
                </td>
                <td className="text-xs">{new Date(t.shippedAt).toLocaleString()}</td>
                <td>{t.ageHours.toFixed(1)}h</td>
              </tr>
            ))}
            {activity.openInTransit.length === 0 && (
              <tr>
                <td colSpan={3} style={{ color: "var(--muted)" }}>
                  Nothing in transit
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
