import { prisma } from "@/lib/prisma";
import type { SessionUser } from "@/lib/rbac";

/** Re-read access on every server authentication check; JWTs prove identity only. */
export async function currentSessionUser(id: string, sessionVersion = 0): Promise<SessionUser | null> {
  const user = await prisma.user.findUnique({ where: { id }, include: { branches: true } });
  if (!user?.active || user.sessionVersion !== sessionVersion) return null;
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    organizationId: user.organizationId,
    branchIds: user.branches.map((branch) => branch.branchId),
  };
}
