"use client";

import { useState, useTransition } from "react";
import { createUserAction, updateUserAction } from "@/actions";
import { confirmed } from "@/lib/confirm";

type UserRow = {
  id: string;
  name: string;
  username: string | null;
  email: string | null;
  role: "OWNER" | "MANAGER" | "CASHIER";
  branchCodes: string[] | null;
  branchIds: string[];
  active: boolean;
};

type Branch = { id: string; code: string; name: string };

export function UsersClient({ users, branches, currentUserId }: { users: UserRow[]; branches: Branch[]; currentUserId: string }) {
  const [editing, setEditing] = useState<UserRow | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"OWNER" | "MANAGER" | "CASHIER">("CASHIER");
  const [branchIds, setBranchIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [createdUsername, setCreatedUsername] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function toggleBranch(id: string) {
    setBranchIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  }

  function reset() {
    setFirstName("");
    setLastName("");
    setEmail("");
    setPassword("");
    setRole("CASHIER");
    setBranchIds([]);
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setCreatedUsername(null);
    const fd = new FormData();
    fd.set("firstName", firstName);
    fd.set("lastName", lastName);
    fd.set("email", email);
    fd.set("password", password);
    fd.set("role", role);
    for (const id of branchIds) fd.append("branchIds", id);

    startTransition(async () => {
      const res = await createUserAction(fd);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setCreatedUsername(res.username ?? null);
      reset();
    });
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1.2fr_1fr]">
      <div className="panel min-w-0 overflow-x-auto p-4">
        {saved && <p role="status" className="mb-3 text-sm">{saved}</p>}
        <table className="table w-full table-fixed">
          <thead>
            <tr>
              <th className="w-[40%]">Name / login</th>
              <th className="w-[27%]">Access</th>
              <th className="w-[16%]">Status</th>
              <th className="w-[17%]"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td className="font-medium">{u.name}
                  <div className="truncate text-xs font-normal" title={u.username ?? u.email ?? ""} style={{ color: "var(--muted)" }}>{u.username ?? u.email}</div>
                  {u.username && u.email && <div className="truncate text-xs font-normal" title={u.email} style={{ color: "var(--muted)" }}>{u.email}</div>}
                </td>
                <td className="text-xs">{u.role}<div className="mt-1" style={{ color: "var(--muted)" }}>{u.role === "OWNER" ? "All branches" : u.branchCodes?.join(", ") || "No branches"}</div></td>
                <td><span className="text-xs">{u.active ? "Active" : "Inactive"}</span></td>
                <td><button type="button" className="btn-secondary" onClick={() => { setEditing(u); setSaved(null); }} aria-label={`Edit ${u.name}`}>Edit</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editing ? <UserEditor key={editing.id} user={editing} branches={branches} isSelf={editing.id === currentUserId}
        onCancel={() => setEditing(null)} onSaved={() => { setSaved(`Updated ${editing.name}. Access changes take effect immediately.`); setEditing(null); }} /> : <form onSubmit={submit} className="panel space-y-3 p-4">
        <h2 className="font-semibold">Create user</h2>
        <p className="text-xs" style={{ color: "var(--muted)" }}>
          No email needed. A login username is generated automatically (first initial + last
          name, e.g. &ldquo;Mike Rupisan&rdquo; &rarr; &ldquo;mrupisan&rdquo;) &mdash; you set the password below.
        </p>

        {createdUsername && (
          <div className="rounded-lg border p-3 text-sm" style={{ borderColor: "var(--accent)", background: "var(--accent-soft)" }}>
            <div className="font-semibold" style={{ color: "var(--accent)" }}>
              Account created
            </div>
            <div className="mt-1">
              Login username: <span className="num font-bold">{createdUsername}</span>
            </div>
            <div className="text-xs" style={{ color: "var(--muted)" }}>
              The username is also listed in the Login column.
            </div>
          </div>
        )}

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="label">First name</label>
            <input
              className="field"
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              required
            />
          </div>
          <div>
            <label className="label">Last name</label>
            <input className="field" value={lastName} onChange={(e) => setLastName(e.target.value)} required />
          </div>
        </div>
        <div>
          <label className="label">Email (optional)</label>
          <input
            type="email"
            className="field"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Leave blank for cashiers"
          />
        </div>
        <div>
          <label className="label">Password</label>
          <input
            type="password"
            autoComplete="new-password"
            className="field"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={6}
          />
        </div>
        <div>
          <label className="label">Role</label>
          <select
            className="field"
            value={role}
            onChange={(e) => setRole(e.target.value as typeof role)}
          >
            <option value="OWNER">Owner</option>
            <option value="MANAGER">Manager</option>
            <option value="CASHIER">Cashier</option>
          </select>
        </div>
        {role !== "OWNER" && (
          <fieldset className="space-y-1">
            <legend className="label">Branch access</legend>
            {branches.map((b) => (
              <label key={b.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={branchIds.includes(b.id)}
                  onChange={() => toggleBranch(b.id)}
                />
                {b.code} — {b.name}
              </label>
            ))}
          </fieldset>
        )}

        {error && (
          <p className="text-sm" style={{ color: "var(--danger)" }}>
            {error}
          </p>
        )}

        <button type="submit" className="btn-primary w-full" disabled={pending}>
          {pending ? "Creating…" : "Create user"}
        </button>
      </form>}
    </div>
  );
}

function UserEditor({ user, branches, isSelf, onCancel, onSaved }: {
  user: UserRow; branches: Branch[]; isSelf: boolean; onCancel: () => void; onSaved: () => void;
}) {
  const [name, setName] = useState(user.name);
  const [email, setEmail] = useState(user.email ?? "");
  const [role, setRole] = useState(user.role);
  const [active, setActive] = useState(user.active);
  const [branchIds, setBranchIds] = useState(user.branchIds);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (user.active && !active && !confirmed(`Deactivate ${user.name}? They will be signed out and unable to sign in.`)) return;
    if (password && !confirmed(`Reset ${user.name}'s password? Existing sessions will be signed out.`)) return;
    setError(null);
    startTransition(async () => {
      const result = await updateUserAction({ userId: user.id, name, email, role, active, branchIds, password });
      if (!result.ok) setError(result.error);
      else onSaved();
    });
  }

  return <form onSubmit={submit} className="panel space-y-4 p-4" aria-label="Edit user">
    <div className="flex items-center justify-between gap-2"><h2 className="font-semibold">Edit {user.name}</h2><button type="button" className="btn-secondary" disabled={pending} onClick={onCancel}>Cancel</button></div>
    <p className="text-xs" style={{ color: "var(--muted)" }}>Login: {user.username ?? user.email}. Role and branch changes apply immediately.</p>
    <label className="block"><span className="label">Full name</span><input className="field" value={name} onChange={e => setName(e.target.value)} required maxLength={100} /></label>
    <label className="block"><span className="label">{user.username ? "Email (optional)" : "Login email"}</span><input className="field" type="email" value={email} required={!user.username} onChange={e => setEmail(e.target.value)} /></label>
    <label className="block"><span className="label">Role</span><select className="field" value={role} disabled={isSelf} onChange={e => setRole(e.target.value as UserRow["role"])}>
      <option value="OWNER">Owner</option><option value="MANAGER">Manager</option><option value="CASHIER">Cashier</option>
    </select></label>
    {role !== "OWNER" && <fieldset className="space-y-2"><legend className="label">Branch access</legend>{branches.map(branch => <label key={branch.id} className="flex items-center gap-2 text-sm">
      <input type="checkbox" checked={branchIds.includes(branch.id)} onChange={() => setBranchIds(ids => ids.includes(branch.id) ? ids.filter(id => id !== branch.id) : [...ids, branch.id])} />{branch.code} — {branch.name}
    </label>)}</fieldset>}
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={active} disabled={isSelf} onChange={e => setActive(e.target.checked)} />Account active</label>
    {isSelf && <p className="text-xs" style={{ color: "var(--muted)" }}>Another owner must change your role or deactivate your account.</p>}
    <label className="block"><span className="label">New password (optional)</span><input className="field" type="password" autoComplete="new-password" value={password} minLength={6} onChange={e => setPassword(e.target.value)} /></label>
    <p className="text-xs" style={{ color: "var(--muted)" }}>Leave the password blank to keep the current one.</p>
    {error && <p role="alert" className="text-sm" style={{ color: "var(--danger)" }}>{error}</p>}
    <button type="submit" className="btn-primary w-full" disabled={pending}>{pending ? "Saving…" : "Save changes"}</button>
  </form>;
}
