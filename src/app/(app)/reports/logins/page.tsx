import { Role } from "@prisma/client";
import { requireManager } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { getLoginActivity } from "@/lib/reports";
import { resolveReportFilters } from "@/lib/reportFilters";
import { ReportFilterBar } from "@/components/report-filter-bar";
import { ReportsNav } from "@/components/reports-nav";
import { Badge } from "@/components/badge";

export default async function LoginsReportPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string; branchId?: string }>;
}) {
  const user = await requireManager();
  const params = await searchParams;
  const { days, branches, branchId, since } = await resolveReportFilters(user, params);

  // Owner sees every staff member; a manager sees staff who share a branch with them
  // (LoginEvent itself has no branch — a login happens before a branch is chosen).
  const staff =
    user.role === Role.OWNER
      ? await prisma.user.findMany({ where: { organizationId: user.organizationId }, select: { id: true } })
      : await prisma.user.findMany({
          where: {
            organizationId: user.organizationId,
            branches: { some: { branchId: { in: branchId ? [branchId] : branches.map((b) => b.id) } } },
          },
          select: { id: true },
        });

  const activity = await getLoginActivity(
    staff.map((s) => s.id),
    { since },
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Staff logins</h1>
          <p className="text-sm" style={{ color: "var(--muted)" }}>
            First POS login per person per day &mdash; the check-in time that matters for a shift, not every
            re-login through the day.
          </p>
        </div>
        <ReportFilterBar days={days} branches={branches} branchId={branchId} role={user.role} />
      </div>
      <ReportsNav />

      {activity.length === 0 ? (
        <div className="panel p-4">
          <p className="text-sm" style={{ color: "var(--muted)" }}>
            No logins recorded in this range.
          </p>
        </div>
      ) : (
        <div className="panel overflow-x-auto p-4">
          <table className="table">
            <thead>
              <tr>
                <th>Day</th>
                <th>Staff</th>
                <th>Role</th>
                <th>First login (Manila time)</th>
                <th>Logins that day</th>
              </tr>
            </thead>
            <tbody>
              {activity.map((a) => (
                <tr key={`${a.userId}:${a.day}`}>
                  <td className="num">{a.day}</td>
                  <td>{a.userName}</td>
                  <td>
                    <Badge tone={a.role === "CASHIER" ? "neutral" : "good"}>{a.role.toLowerCase()}</Badge>
                  </td>
                  <td className="num">
                    {new Date(a.firstLoginAt).toLocaleTimeString("en-PH", {
                      timeZone: "Asia/Manila",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </td>
                  <td className="num">{a.loginCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="panel p-4">
        <p className="text-xs" style={{ color: "var(--muted)" }}>
          This only shows logins from the moment this feature shipped (2026-09-29) &mdash; there&apos;s no earlier
          history to backfill. If FoodPanda/GrabFood&apos;s no-late-check-in rule has a specific cutoff time you
          want flagged automatically (e.g. anything after 8:00 AM shown as late), tell me the time per branch and
          I&apos;ll add that.
        </p>
      </div>
    </div>
  );
}
