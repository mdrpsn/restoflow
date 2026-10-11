import { upsertSupplierAction } from "@/actions";
import { prisma } from "@/lib/prisma";
import { requireManager } from "@/lib/session";

async function upsertSupplierFormAction(formData: FormData) {
  "use server";
  await upsertSupplierAction(formData);
}

export default async function SuppliersPage() {
  const user = await requireManager();
  const suppliers = await prisma.supplier.findMany({
    where: { organizationId: user.organizationId },
    orderBy: { name: "asc" },
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Suppliers</h1>
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          Vendors for purchase orders.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1.2fr_1fr]">
        <div className="panel overflow-x-auto p-4">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Phone</th>
                <th>Active</th>
              </tr>
            </thead>
            <tbody>
              {suppliers.map((s) => (
                <tr key={s.id}>
                  <td className="font-medium">{s.name}</td>
                  <td>{s.contactEmail || "—"}</td>
                  <td>{s.contactPhone || "—"}</td>
                  <td>{s.active ? "Yes" : "No"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <form action={upsertSupplierFormAction} className="panel space-y-3 p-4">
          <h2 className="font-semibold">Add supplier</h2>
          <div>
            <label className="label">Name</label>
            <input name="name" className="field" required />
          </div>
          <div>
            <label className="label">Email</label>
            <input name="contactEmail" type="email" className="field" />
          </div>
          <div>
            <label className="label">Phone</label>
            <input name="contactPhone" className="field" />
          </div>
          <div>
            <label className="label">Notes</label>
            <textarea name="notes" className="field" rows={3} />
          </div>
          <button type="submit" className="btn-primary w-full">
            Create
          </button>
        </form>
      </div>
    </div>
  );
}
