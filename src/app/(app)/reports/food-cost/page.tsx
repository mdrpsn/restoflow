import { requireManager } from "@/lib/session";
import { getFoodCostSummary } from "@/lib/reports";
import { resolveReportFilters } from "@/lib/reportFilters";
import { ReportFilterBar } from "@/components/report-filter-bar";
import { ReportsNav } from "@/components/reports-nav";
import { formatMoney } from "@/lib/money";

export default async function FoodCostReportPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string; branchId?: string }>;
}) {
  const user = await requireManager();
  const params = await searchParams;
  const { days, branches, branchId, since, branchIds } = await resolveReportFilters(user, params);

  const summary = await getFoodCostSummary(user.organizationId, branchIds, { since });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Food cost</h1>
        <ReportFilterBar days={days} branches={branches} branchId={branchId} role={user.role} />
      </div>
      <ReportsNav />

      <p className="text-xs" style={{ color: "var(--muted)" }}>
        Cost of goods is the theoretical recipe cost of what was sold (recipe version in effect at
        the time of each sale, current ingredient unit costs). Revenue is completed sales in range.
      </p>

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="panel p-4">
          <div className="text-xs uppercase tracking-wide" style={{ color: "var(--muted)" }}>
            Revenue
          </div>
          <div className="num text-2xl font-semibold">{formatMoney(summary.revenueCents)}</div>
        </div>
        <div className="panel p-4">
          <div className="text-xs uppercase tracking-wide" style={{ color: "var(--muted)" }}>
            Cost of goods (theoretical)
          </div>
          <div className="num text-2xl font-semibold">{formatMoney(summary.cogsCents)}</div>
        </div>
        <div className="panel p-4">
          <div className="text-xs uppercase tracking-wide" style={{ color: "var(--muted)" }}>
            Food cost %
          </div>
          <div className="text-2xl font-semibold">
            {summary.foodCostPercent === null ? "—" : `${summary.foodCostPercent.toFixed(1)}%`}
          </div>
        </div>
      </div>
    </div>
  );
}
