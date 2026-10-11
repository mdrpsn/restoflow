import { Role } from "@prisma/client";
import { startOfDay, subDays } from "date-fns";
import type { SessionUser } from "@/lib/rbac";
import { listAccessibleBranches, getActiveBranchId } from "@/lib/branch";

/**
 * Resolves the days/branch query params shared by every report page into a
 * consistent {since, branchIds} filter, honoring the same rules the original
 * reports page used: an OWNER may view "all my branches" (branchId=""),
 * anyone else is confined to their assigned branches.
 */
export async function resolveReportFilters(
  user: SessionUser,
  params: { days?: string; branchId?: string },
) {
  const days = Math.min(90, Math.max(1, Number(params.days || 7)));
  const branches = await listAccessibleBranches(user);
  const defaultBranch = await getActiveBranchId(user);

  let branchId: string | null;
  if (params.branchId === "" && user.role === Role.OWNER) {
    branchId = null;
  } else if (
    params.branchId &&
    (user.role === Role.OWNER || branches.some((b) => b.id === params.branchId))
  ) {
    branchId = params.branchId;
  } else {
    branchId = defaultBranch;
  }

  const since = startOfDay(subDays(new Date(), days - 1));
  const branchIds = branchId ? [branchId] : branches.map((b) => b.id);

  return { days, branches, branchId, since, branchIds };
}
