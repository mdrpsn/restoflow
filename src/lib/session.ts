import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import type { SessionUser } from "@/lib/rbac";
import { isManagerOrAbove, isOwner, isWarehouseAdmin } from "@/lib/rbac";
import { listAccessibleBranches } from "@/lib/branch";
import type { Role } from "@prisma/client";

export async function requireSession(): Promise<SessionUser> {
  const session = await auth();
  if (!session?.user) redirect("/login");
  return session.user as SessionUser;
}

export async function requireRoles(roles: Role[]): Promise<SessionUser> {
  const user = await requireSession();
  if (!roles.includes(user.role)) redirect("/");
  return user;
}

export async function requireManager(): Promise<SessionUser> {
  const user = await requireSession();
  if (!isManagerOrAbove(user.role)) redirect("/");
  return user;
}

export async function requireOwner(): Promise<SessionUser> {
  const user = await requireSession();
  if (!isOwner(user.role)) redirect("/");
  return user;
}

/** Owner, or a Manager assigned to the warehouse branch. See lib/rbac.ts's isWarehouseAdmin. */
export async function requireWarehouseAdmin(): Promise<SessionUser> {
  const user = await requireSession();
  const branches = await listAccessibleBranches(user);
  if (!isWarehouseAdmin(user.role, branches)) redirect("/");
  return user;
}
