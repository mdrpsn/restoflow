import { prisma } from "@/lib/prisma";
import { requireOwner } from "@/lib/session";
import { UsersClient } from "@/components/users-client";

export default async function UsersPage() {
  const user = await requireOwner();
  const [users, branches] = await Promise.all([
    prisma.user.findMany({
      where: { organizationId: user.organizationId },
      include: { branches: { include: { branch: true } } },
      orderBy: { name: "asc" },
    }),
    prisma.branch.findMany({
      where: { organizationId: user.organizationId },
      orderBy: { name: "asc" },
    }),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Users</h1>
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          Owners see all branches; managers and cashiers are assigned explicitly.
        </p>
      </div>

      <UsersClient
        currentUserId={user.id}
        users={users.map((u) => ({
          id: u.id,
          name: u.name,
          username: u.username,
          email: u.email,
          role: u.role,
          active: u.active,
          branchIds: u.branches.map((b) => b.branchId),
          branchCodes: u.role === "OWNER" ? null : u.branches.map((b) => b.branch.code),
        }))}
        branches={branches.map((b) => ({ id: b.id, code: b.code, name: b.name }))}
      />
    </div>
  );
}
