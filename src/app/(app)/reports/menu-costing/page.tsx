import Link from "next/link";
import { SalesChannel } from "@prisma/client";
import { requireManager } from "@/lib/session";
import { getMenuCosting, MENU_COST_HIGH_PERCENT, MENU_COST_WATCH_PERCENT, PLATFORM_FEE_PERCENT } from "@/lib/reports";
import { ReportsNav } from "@/components/reports-nav";
import { formatMoney } from "@/lib/money";
import { Badge } from "@/components/badge";

const CHANNELS: { value: SalesChannel; label: string }[] = [
  { value: SalesChannel.WALK_IN, label: "Walk-in" },
  { value: SalesChannel.FOODPANDA, label: "FoodPanda" },
  { value: SalesChannel.GRABFOOD, label: "GrabFood" },
];

export default async function MenuCostingPage({
  searchParams,
}: {
  searchParams: Promise<{ channel?: string; category?: string }>;
}) {
  const user = await requireManager();
  const params = await searchParams;
  const channel = CHANNELS.find((c) => c.value === params.channel)?.value ?? SalesChannel.WALK_IN;
  const { rows, withoutRecipe } = await getMenuCosting(user.organizationId, channel);

  const categories = [...new Set(rows.map((r) => r.category))].sort();
  const category = categories.includes(params.category ?? "") ? params.category : undefined;
  const shown = rows
    .filter((r) => !category || r.category === category)
    .sort((a, b) => (b.foodCostPercent ?? 0) - (a.foodCostPercent ?? 0));

  const high = rows.filter((r) => (r.foodCostPercent ?? 0) > MENU_COST_HIGH_PERCENT).length;
  const watch = rows.filter((r) => (r.foodCostPercent ?? 0) > MENU_COST_WATCH_PERCENT && (r.foodCostPercent ?? 0) <= MENU_COST_HIGH_PERCENT).length;
  const incomplete = rows.filter((r) => r.incomplete).length;
  const feePercent = PLATFORM_FEE_PERCENT[channel];
  const losing = rows.filter((r) => r.marginCents < 0).length;
  const href = (next: { channel?: string; category?: string }) => {
    const q = new URLSearchParams();
    const c = next.channel ?? channel;
    if (c !== SalesChannel.WALK_IN) q.set("channel", c);
    if (next.category) q.set("category", next.category);
    const s = q.toString();
    return `/reports/menu-costing${s ? `?${s}` : ""}`;
  };
  const chip = (active: boolean) => ({
    background: active ? "var(--accent-fill)" : "var(--accent-soft)",
    color: active ? "var(--ink)" : "var(--accent)",
  });

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Menu costing</h1>
      <ReportsNav />

      <p className="text-xs" style={{ color: "var(--muted)" }}>
        Recipe cost against selling price for every menu item, worst first. Cost is ingredients
        only (no labor, rent, utilities or platform commission), at the reference sweetness level
        (100%), without paid add-ons. Green up to {MENU_COST_WATCH_PERCENT}% food cost, amber up to{" "}
        {MENU_COST_HIGH_PERCENT}%, red above. Price shown is the {CHANNELS.find((c) => c.value === channel)?.label} price;
        where none is set for a platform it uses the walk-in price.
        {feePercent > 0 && ` Margin is after the platform's ${feePercent}% commission; food cost % stays on the gross price.`}
      </p>

      <div className="grid gap-4 sm:grid-cols-4">
        <Stat label="Items costed" value={String(rows.length)} />
        <Stat label={`Above ${MENU_COST_HIGH_PERCENT}%`} value={String(high)} />
        <Stat label={`${MENU_COST_WATCH_PERCENT}–${MENU_COST_HIGH_PERCENT}%`} value={String(watch)} />
        <Stat label={feePercent > 0 ? "Losing money after fee" : "Cost incomplete"} value={String(feePercent > 0 ? losing : incomplete)} />
      </div>
      {incomplete > 0 && (
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          &ldquo;Incomplete&rdquo; rows use an ingredient with no price entered, so their real cost
          is higher than shown. Fix them on{" "}
          <Link href="/reports/recipe-health" className="underline">Recipe health</Link>.
          {withoutRecipe > 0 && ` ${withoutRecipe} active products have no recipe yet and are not listed.`}
        </p>
      )}

      <div className="flex flex-wrap gap-1">
        {CHANNELS.map((c) => (
          <Link key={c.value} href={href({ channel: c.value, category })} className="rounded-lg px-3 py-1.5 text-sm" style={chip(c.value === channel)}>
            {c.label}
          </Link>
        ))}
      </div>
      <div className="flex flex-wrap gap-1">
        <Link href={href({})} className="rounded-lg px-2.5 py-1 text-xs" style={chip(!category)}>All categories</Link>
        {categories.map((c) => (
          <Link key={c} href={href({ category: c })} className="rounded-lg px-2.5 py-1 text-xs" style={chip(c === category)}>
            {c}
          </Link>
        ))}
      </div>

      <div className="panel overflow-x-auto p-4">
        <table className="table">
          <thead>
            <tr>
              <th>Item</th>
              <th>Category</th>
              <th className="text-right">Price</th>
              {feePercent > 0 && <th className="text-right">Fee ({feePercent}%)</th>}
              <th className="text-right">Cost</th>
              <th className="text-right">Margin</th>
              <th className="text-right">Food cost %</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const pct = r.foodCostPercent;
              const tone = pct === null ? "warn" : pct > MENU_COST_HIGH_PERCENT ? "bad" : pct > MENU_COST_WATCH_PERCENT ? "warn" : "good";
              return (
                <tr key={r.id}>
                  <td>
                    {r.name}
                    {r.incomplete && <> <Badge tone="warn">cost incomplete</Badge></>}
                  </td>
                  <td className="text-xs" style={{ color: "var(--muted)" }}>{r.category}</td>
                  <td className="num text-right">{formatMoney(r.priceCents)}</td>
                  {feePercent > 0 && <td className="num text-right">{formatMoney(r.feeCents)}</td>}
                  <td className="num text-right">{formatMoney(Math.round(r.costCents))}</td>
                  <td className="num whitespace-nowrap text-right">{formatMoney(Math.round(r.marginCents))}</td>
                  <td className="num text-right">
                    <Badge tone={tone}>{pct === null ? "—" : `${pct.toFixed(1)}%`}</Badge>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="panel p-4">
      <div className="text-xs uppercase tracking-wide" style={{ color: "var(--muted)" }}>{label}</div>
      <div className="num text-2xl font-semibold">{value}</div>
    </div>
  );
}
