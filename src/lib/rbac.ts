import { Role } from "@prisma/client";

export type SessionUser = {
  id: string;
  email: string | null;
  name: string;
  role: Role;
  organizationId: string;
  branchIds: string[];
};

export function isManagerOrAbove(role: Role): boolean {
  return role === Role.OWNER || role === Role.MANAGER;
}

export function isOwner(role: Role): boolean {
  return role === Role.OWNER;
}

/**
 * "Warehouse admin" isn't a distinct Role — it's the Owner, or a Manager
 * whose branch assignments include the org's warehouse. Inventory levels and
 * transfers are restricted to this group; everyone else uses stock requests
 * instead (see lib/stockRequests.ts) so they never see on-hand quantities.
 */
export function isWarehouseAdmin(role: Role, accessibleBranches: { type: string }[]): boolean {
  if (role === Role.OWNER) return true;
  if (role !== Role.MANAGER) return false;
  return accessibleBranches.some((b) => b.type === "WAREHOUSE");
}

export function canAccessBranch(user: SessionUser, branchId: string): boolean {
  if (user.role === Role.OWNER) return true;
  return user.branchIds.includes(branchId);
}
