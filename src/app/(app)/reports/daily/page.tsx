import Link from "next/link";
import { requireManager } from "@/lib/session";
import { listAccessibleBranches, getActiveBranchId } from "@/lib/branch";
import { getDailyOperationsSummary } from "@/lib/dailySummary";
import { todayInBusinessTz } from "@/lib/warehouseImportCore";
import { ReportsNav } from "@/components/reports-nav";
import { formatMoney } from "@/lib/money";
import { Badge } from "@/components/badge";
import { DailySummaryAiPanel } from "@/components/daily-summary-ai-panel";
import { AllBranchesAiPanel } from "@/components/all-branches-ai-panel";

export default async function DailySummaryPage({
  searchParams,
}: {
  searchParams: Promise<{ branch?: string; date?: string }>;
}) {
  const user = await requireManager();
  const params = await searchParams;
  const allBranches = await listAccessibleBranches(user);
  const branches = allBranches.filter((b) => b.type === "STORE");
  const activeBranchId = await getActiveBranchId(user);
  const activeBranch = branches.find((b) => b.id === activeBranchId);
  const date = params.date || todayInBusinessTz();

  if (branches.length === 0) {
    return (
      <div className="panel p-4">
        <p className="text-sm">No store branch available for this account.</p>
      </div>
    );
  }

  // No ?branch= and more than one store to look at: show every branch's numbers
  // side by side with one button to generate all their AI overviews at once,
  // instead of switching branches in the dropdown one at a time.
  if (!params.branch && branches.length > 1) {
    const summaries = await Promise.all(
      branches.map((b) =>
        getDailyOperationsSummary({ organizationId: user.organizationId, branchCode: b.code, date }),
      ),
    );
    const totalRevenueCents = summaries.reduce((s, x) => s + x.sales.revenueCents, 0);
    const totalTransactions = summaries.reduce((s, x) => s + x.sales.transactions, 0);
    const totalCritical = summaries.reduce((s, x) => s + x.inventory.critical.length, 0);
    const allQuiet = totalTransactions === 0;

    return (
      <div className="space-y-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Daily summary &mdash; all branches</h1>
            <p className="text-sm" style={{ color: "var(--muted)" }}>
              {date} (Asia/Manila) &middot; the branch switcher in the sidebar doesn&apos;t affect this report
            </p>
          </div>
          <form className="flex flex-wrap items-center gap-2" method="get">
            <input type="date" name="date" defaultValue={date} className="field w-auto" />
            <button type="submit" className="btn-primary">
              View report
            </button>
          </form>
        </div>

        <ReportsNav />

        <div className="panel p-4">
          <div className="text-xs uppercase tracking-wide" style={{ color: "var(--muted)" }}>
            All branches combined
          </div>
          <div className="num text-3xl font-semibold">{formatMoney(totalRevenueCents)}</div>
          <div className="text-sm" style={{ color: "var(--muted)" }}>
            {totalTransactions} sale{totalTransactions === 1 ? "" : "s"} across {branches.length} branches
            {totalCritical > 0 && (
              <span className="ml-2">
                <Badge tone="bad">{totalCritical} critical stock alert{totalCritical === 1 ? "" : "s"}</Badge>
              </span>
            )}
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {summaries.map((s) => (
            <Link
              key={s.branch.code}
              href={`/reports/daily?branch=${s.branch.code}&date=${date}`}
              className="panel block p-3 transition hover:border-[var(--accent)]"
            >
              <div className="truncate text-sm font-semibold">{s.branch.name}</div>
              <div className="mb-1 text-xs" style={{ color: "var(--muted)" }}>
                {s.branch.code}
              </div>
              <div className="num text-lg font-semibold">{formatMoney(s.sales.revenueCents)}</div>
              <div className="text-xs" style={{ color: "var(--muted)" }}>
                {s.sales.transactions} sale{s.sales.transactions === 1 ? "" : "s"}
                {s.inventory.critical.length > 0 && (
                  <span className="ml-1">
                    <Badge tone="bad">{s.inventory.critical.length} critical</Badge>
                  </span>
                )}
              </div>
            </Link>
          ))}
        </div>

        {allQuiet ? (
          <p className="rounded-lg border px-3 py-2 text-sm" style={{ borderColor: "var(--line)", color: "var(--muted)" }}>
            No transactions recorded across all branches for {date} &mdash; no AI overview generated (nothing to
            narrate, and it saves the day&apos;s quota).
          </p>
        ) : (
          <AllBranchesAiPanel
            branches={summaries.map((s) => ({
              code: s.branch.code,
              name: s.branch.name,
              transactions: s.sales.transactions,
            }))}
            date={date}
          />
        )}
      </div>
    );
  }

  const branchCode = params.branch || activeBranch?.code || branches[0]?.code;

  const summary = await getDailyOperationsSummary({
    organizationId: user.organizationId,
    branchCode,
    date,
  });

  const CHANNEL_LABELS: Record<string, string> = {
    WALK_IN: "Walk-in / Takeout",
    FOODPANDA: "FoodPanda",
    GRABFOOD: "GrabFood",
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Daily summary</h1>
          <p className="text-sm" style={{ color: "var(--muted)" }}>
            {summary.branch.name} &middot; {summary.date} ({summary.timezone})
            {branches.length > 1 && (
              <>
                {" "}
                &middot; <Link href={`/reports/daily?date=${date}`}>All branches</Link>
              </>
            )}
          </p>
        </div>
        <form className="flex flex-wrap items-center gap-2" method="get">
          <select name="branch" defaultValue={branchCode} className="field w-auto" aria-label="Branch shown on this report">
            {branches.map((b) => (
              <option key={b.id} value={b.code}>
                {b.name} ({b.code})
              </option>
            ))}
          </select>
          <input type="date" name="date" defaultValue={date} className="field w-auto" />
          <button type="submit" className="btn-primary">
            View report
          </button>
        </form>
      </div>

      <ReportsNav />

      {summary.sales.transactions === 0 ? (
        <p className="rounded-lg border px-3 py-2 text-sm" style={{ borderColor: "var(--line)", color: "var(--muted)" }}>
          No transactions recorded for {summary.branch.name} on {date} &mdash; no AI overview generated.
        </p>
      ) : (
        <DailySummaryAiPanel branchCode={branchCode} date={date} />
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="panel p-4">
          <div className="text-xs uppercase tracking-wide" style={{ color: "var(--muted)" }}>
            Revenue
          </div>
          <div className="num text-2xl font-semibold">{formatMoney(summary.sales.revenueCents)}</div>
          <div className="text-xs" style={{ color: "var(--muted)" }}>
            {summary.sales.transactions} sale{summary.sales.transactions === 1 ? "" : "s"} &middot; avg{" "}
            {formatMoney(summary.sales.averageTicketCents)}
          </div>
        </div>
        <div className="panel p-4">
          <div className="text-xs uppercase tracking-wide" style={{ color: "var(--muted)" }}>
            Food cost
          </div>
          <div className="text-2xl font-semibold">
            {summary.foodCost.foodCostPercent === null ? "—" : `${summary.foodCost.foodCostPercent.toFixed(1)}%`}
          </div>
          <div className="text-xs" style={{ color: "var(--muted)" }}>
            COGS {formatMoney(summary.foodCost.cogsCents)}
          </div>
        </div>
        <div className="panel p-4">
          <div className="text-xs uppercase tracking-wide" style={{ color: "var(--muted)" }}>
            Recipe coverage
          </div>
          <div className="text-2xl font-semibold">{summary.recipeCoverage.revenuePercent.toFixed(0)}%</div>
          <div className="text-xs" style={{ color: "var(--muted)" }}>
            of revenue mapped to a recipe
          </div>
        </div>
        <div className="panel p-4">
          <div className="text-xs uppercase tracking-wide" style={{ color: "var(--muted)" }}>
            Waste value
          </div>
          <div className="num text-2xl font-semibold">{formatMoney(summary.waste.totalValueCents)}</div>
          <div className="text-xs" style={{ color: "var(--muted)" }}>
            {summary.waste.entries.length} entr{summary.waste.entries.length === 1 ? "y" : "ies"}
          </div>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="panel p-4">
          <h2 className="mb-3 font-semibold">Sales by channel</h2>
          {summary.sales.channels.length === 0 ? (
            <p className="text-sm" style={{ color: "var(--muted)" }}>
              No sales.
            </p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Channel</th>
                  <th>Tickets</th>
                  <th>Revenue</th>
                </tr>
              </thead>
              <tbody>
                {summary.sales.channels.map((c) => (
                  <tr key={c.channel}>
                    <td>{CHANNEL_LABELS[c.channel] ?? c.channel}</td>
                    <td className="num">{c.count}</td>
                    <td className="num">{formatMoney(c.revenueCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="panel p-4">
          <h2 className="mb-3 font-semibold">Stock alerts</h2>
          <p className="mb-2 text-sm">
            {summary.inventory.critical.length} critical &middot; {summary.inventory.low.length} low &middot; of{" "}
            {summary.inventory.trackedCount} tracked
          </p>
          {summary.inventory.critical.length === 0 ? (
            <p className="text-sm" style={{ color: "var(--accent)" }}>
              Nothing critical.
            </p>
          ) : (
            <ul className="space-y-1 text-sm">
              {summary.inventory.critical.slice(0, 8).map((i) => (
                <li key={i.ingredientName} className="flex items-center justify-between">
                  <span>{i.ingredientName}</span>
                  <Badge tone="bad">
                    {i.quantity} {i.unit}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {summary.recipeCoverage.unmappedProducts.length > 0 && (
        <div className="panel p-4">
          <h2 className="mb-1 font-semibold">
            Sold with no recipe ({summary.recipeCoverage.unmappedProducts.length})
          </h2>
          <p className="mb-3 text-xs" style={{ color: "var(--muted)" }}>
            These sales didn&apos;t deduct any stock and aren&apos;t in the food-cost figure above.
          </p>
          <table className="table">
            <thead>
              <tr>
                <th>Product</th>
                <th>Qty</th>
                <th>Revenue</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {summary.recipeCoverage.unmappedProducts.slice(0, 15).map((p) => (
                <tr key={p.productId}>
                  <td>{p.name}</td>
                  <td className="num">{p.quantity}</td>
                  <td className="num">{formatMoney(p.revenueCents)}</td>
                  <td>
                    <Link href="/catalog/products" className="btn-secondary px-2 py-1 text-xs">
                      Add recipe
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
