import { AppShell } from "@/components/app-shell";
import { requireSession } from "@/lib/session";
import { getActiveBranchId, listAccessibleBranches } from "@/lib/branch";
import { isWarehouseAdmin } from "@/lib/rbac";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireSession();
  const branches = await listAccessibleBranches(user);
  const activeBranchId = await getActiveBranchId(user);

  return (
    <AppShell
      user={{ name: user.name, email: user.email, role: user.role }}
      branches={branches}
      activeBranchId={activeBranchId}
      isWarehouseAdmin={isWarehouseAdmin(user.role, branches)}
    >
      {children}
    </AppShell>
  );
}
