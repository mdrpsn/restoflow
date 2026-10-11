import { afterEach, describe, expect, it } from "vitest";
import { compare } from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { createUser, updateUser } from "@/lib/users";
import { currentSessionUser } from "@/lib/sessionUser";
import { createFixture, cleanupFixture } from "./testFixture";

describe("staff access management", () => {
  const organizations: string[] = [];
  afterEach(async () => { for (const id of organizations.splice(0)) await cleanupFixture(id); });
  async function fixture() {
    const data = await createFixture();
    organizations.push(data.org.id);
    const owner = await prisma.user.create({ data: { organizationId: data.org.id, name: "Owner", username: `owner-${data.org.id}`, role: "OWNER", passwordHash: "unused" } });
    const edit = { userId: data.cashier.id, name: data.cashier.name, email: data.cashier.email!, active: true, role: "CASHIER" as const, branchIds: [data.branchA.id] };
    return { ...data, owner, edit };
  }

  it("reloads changed roles and branch access for an existing session", async () => {
    const { org, owner, cashier, branchA, branchB, edit } = await fixture();
    await updateUser(org.id, owner.id, edit);
    expect((await currentSessionUser(cashier.id))?.branchIds).toEqual([branchA.id]);
    await updateUser(org.id, owner.id, { ...edit, role: "MANAGER", branchIds: [branchB.id] });
    const session = await currentSessionUser(cashier.id);
    expect(session?.role).toBe("MANAGER");
    expect(session?.branchIds).toEqual([branchB.id]);
  });

  it("deactivation revokes sessions even after the account is reactivated", async () => {
    const { org, owner, cashier, edit } = await fixture();
    await updateUser(org.id, owner.id, { ...edit, active: false, branchIds: [] });
    expect(await currentSessionUser(cashier.id)).toBeNull();
    await updateUser(org.id, owner.id, edit);
    expect(await currentSessionUser(cashier.id)).toBeNull();
    expect(await currentSessionUser(cashier.id, 1)).not.toBeNull();
  });

  it("resets passwords and invalidates old sessions", async () => {
    const { org, owner, cashier, edit } = await fixture();
    await updateUser(org.id, owner.id, { ...edit, password: "replacement123" });
    const updated = await prisma.user.findUniqueOrThrow({ where: { id: cashier.id } });
    expect(await compare("replacement123", updated.passwordHash)).toBe(true);
    expect(await currentSessionUser(cashier.id)).toBeNull();
    expect(await currentSessionUser(cashier.id, updated.sessionVersion)).not.toBeNull();
  });

  it("rejects foreign branch assignments and users without changing access", async () => {
    const local = await fixture();
    const other = await fixture();
    await expect(updateUser(local.org.id, local.owner.id, { ...local.edit, branchIds: [other.branchA.id] })).rejects.toThrow(/your organization/);
    await expect(updateUser(local.org.id, local.owner.id, { ...local.edit, userId: other.cashier.id })).rejects.toThrow(/not found/);
    await expect(createUser({ organizationId: local.org.id, firstName: "Foreign", lastName: "Branch", password: "password123", role: "CASHIER", branchIds: [other.branchA.id] })).rejects.toThrow(/your organization/);
  });

  it("prevents self-lockout and account updates by non-owners", async () => {
    const { org, owner, cashier, edit } = await fixture();
    await expect(updateUser(org.id, owner.id, { ...edit, userId: owner.id, active: false })).rejects.toThrow(/another owner/);
    await expect(updateUser(org.id, cashier.id, edit)).rejects.toThrow(/active owner/);
  });

  it("serializes two owners deactivating each other so one owner survives", async () => {
    const { org, owner, edit } = await fixture();
    const other = await prisma.user.create({ data: { organizationId: org.id, name: "Other owner", username: `other-${org.id}`, role: "OWNER", passwordHash: "unused" } });
    const results = await Promise.allSettled([
      updateUser(org.id, owner.id, { ...edit, email: "", userId: other.id, role: "OWNER", active: false, branchIds: [] }),
      updateUser(org.id, other.id, { ...edit, email: "", userId: owner.id, role: "OWNER", active: false, branchIds: [] }),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(await prisma.user.count({ where: { organizationId: org.id, active: true, role: "OWNER" } })).toBe(1);
  });

  it("does not remove the only login identifier from older accounts", async () => {
    const { org, owner, edit } = await fixture();
    await expect(updateUser(org.id, owner.id, { ...edit, email: "" })).rejects.toThrow(/uses email/);
  });
});
