import { cookies } from "next/headers";
import { prisma } from "@/lib/prisma";
import type { SessionUser } from "@/lib/rbac";
import { canAccessBranch } from "@/lib/rbac";
import { Role } from "@prisma/client";

export const BRANCH_COOKIE = "restoflow_branch";

export async function listAccessibleBranches(user: SessionUser) {
  if (user.role === Role.OWNER) {
    return prisma.branch.findMany({
      where: { organizationId: user.organizationId },
      orderBy: { name: "asc" },
    });
  }
  return prisma.branch.findMany({
    where: {
      organizationId: user.organizationId,
      id: { in: user.branchIds },
    },
    orderBy: { name: "asc" },
  });
}

export async function getActiveBranchId(user: SessionUser): Promise<string | null> {
  const branches = await listAccessibleBranches(user);
  if (branches.length === 0) return null;

  const jar = await cookies();
  const preferred = jar.get(BRANCH_COOKIE)?.value;
  if (preferred && canAccessBranch(user, preferred) && branches.some((b) => b.id === preferred)) {
    return preferred;
  }
  return branches[0].id;
}

export async function requireActiveBranch(user: SessionUser) {
  const branchId = await getActiveBranchId(user);
  if (!branchId) throw new Error("No branch available for this user");
  if (!canAccessBranch(user, branchId)) throw new Error("Branch access denied");
  const branch = await prisma.branch.findFirstOrThrow({
    where: { id: branchId, organizationId: user.organizationId },
  });
  return branch;
}
