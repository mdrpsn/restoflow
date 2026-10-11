import { createBranchAction } from "@/actions";
import { prisma } from "@/lib/prisma";
import { requireOwner } from "@/lib/session";

async function createBranchFormAction(formData: FormData) {
  "use server";
  await createBranchAction(formData);
}

export default async function BranchesPage() {
  const user = await requireOwner();
  const branches = await prisma.branch.findMany({
    where: { organizationId: user.organizationId },
    orderBy: { name: "asc" },
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Branches</h1>
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          Locations under your organization.
        </p>
      </div>
      <div className="grid gap-6 lg:grid-cols-[1.2fr_1fr]">
        <div className="panel overflow-x-auto p-4">
          <table className="table">
            <thead>
              <tr>
                <th>Code</th>
                <th>Name</th>
                <th>Type</th>
              </tr>
            </thead>
            <tbody>
              {branches.map((b) => (
                <tr key={b.id}>
                  <td className="font-mono text-sm">{b.code}</td>
                  <td className="font-medium">{b.name}</td>
                  <td className="text-xs" style={{ color: "var(--muted)" }}>
                    {b.type === "WAREHOUSE" ? "Warehouse" : "Store"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <form action={createBranchFormAction} className="panel space-y-3 p-4">
          <h2 className="font-semibold">Add branch</h2>
          <div>
            <label className="label">Name</label>
            <input name="name" className="field" required />
          </div>
          <div>
            <label className="label">Code</label>
            <input name="code" className="field" required maxLength={8} placeholder="NW" />
          </div>
          <div>
            <label className="label">Type</label>
            <select name="type" className="field" defaultValue="STORE">
              <option value="STORE">Store (sells)</option>
              <option value="WAREHOUSE">Warehouse (stock only)</option>
            </select>
          </div>
          <button type="submit" className="btn-primary w-full">
            Create
          </button>
        </form>
      </div>
    </div>
  );
}
