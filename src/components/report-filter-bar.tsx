import { Role } from "@prisma/client";

type Branch = { id: string; code: string; name: string };

export function ReportFilterBar({
  days,
  branches,
  branchId,
  role,
}: {
  days: number;
  branches: Branch[];
  branchId: string | null;
  role: Role;
}) {
  return (
    <form className="report-filter-bar">
      <label><span>Period</span><select name="days" className="field" defaultValue={String(days)}>
        {[7, 14, 30, 90].map((d) => (
          <option key={d} value={d}>
            {d} days
          </option>
        ))}
      </select></label>
      <label><span>Branch</span><select name="branchId" className="field" defaultValue={branchId ?? ""}>
        {role === Role.OWNER && <option value="">All my branches</option>}
        {branches.map((b) => (
          <option key={b.id} value={b.id}>
            {b.name} ({b.code})
          </option>
        ))}
      </select></label>
      <button type="submit" className="btn-primary">
        Update view
      </button>
    </form>
  );
}
