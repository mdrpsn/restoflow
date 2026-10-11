import { afterEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { createUser } from "@/lib/users";
import { createFixture, cleanupFixture } from "./testFixture";

describe("createUser", () => {
  let orgId: string | null = null;

  afterEach(async () => {
    if (orgId) await cleanupFixture(orgId);
    orgId = null;
  });

  it("rejects creating a non-owner user with no branches assigned", async () => {
    const { org } = await createFixture();
    orgId = org.id;

    await expect(
      createUser({
        organizationId: org.id,
        firstName: "Broken",
        lastName: "Cashier",
        password: "password123",
        role: "CASHIER",
        branchIds: [],
      }),
    ).rejects.toThrow(/at least one branch/i);

    const created = await prisma.user.findUnique({ where: { username: "bcashier" } });
    expect(created).toBeNull();
  });

  it("rejects creating a manager with no branches assigned", async () => {
    const { org } = await createFixture();
    orgId = org.id;

    await expect(
      createUser({
        organizationId: org.id,
        firstName: "Broken",
        lastName: "Manager",
        password: "password123",
        role: "MANAGER",
        branchIds: [],
      }),
    ).rejects.toThrow(/at least one branch/i);
  });

  it("allows creating an owner with no branches assigned (org-wide access by design)", async () => {
    const { org } = await createFixture();
    orgId = org.id;

    const owner = await createUser({
      organizationId: org.id,
      firstName: "New",
      lastName: "Owner",
      password: "password123",
      role: "OWNER",
      branchIds: [],
    });
    expect(owner.id).toBeTruthy();
  });

  it("creates a user with no email, generating a username instead (first initial + last name)", async () => {
    const { org, branchA } = await createFixture();
    orgId = org.id;

    const cashier = await createUser({
      organizationId: org.id,
      firstName: "Mike",
      lastName: "Rupisan",
      password: "password123",
      role: "CASHIER",
      branchIds: [branchA.id],
    });

    expect(cashier.username).toBe("mrupisan");
    expect(cashier.email).toBeNull();
    expect(cashier.name).toBe("Mike Rupisan");

    const assigned = await prisma.userBranch.findMany({ where: { userId: cashier.id } });
    expect(assigned.map((b) => b.branchId)).toEqual([branchA.id]);
  });

  it("appends a number when the generated username is already taken", async () => {
    const { org, branchA } = await createFixture();
    orgId = org.id;

    const first = await createUser({
      organizationId: org.id,
      firstName: "Mike",
      lastName: "Rupisan",
      password: "password123",
      role: "CASHIER",
      branchIds: [branchA.id],
    });
    const second = await createUser({
      organizationId: org.id,
      firstName: "Maria",
      lastName: "Rupisan",
      password: "password123",
      role: "CASHIER",
      branchIds: [branchA.id],
    });

    expect(first.username).toBe("mrupisan");
    expect(second.username).toBe("mrupisan2");
  });

  it("still accepts an optional email alongside the generated username", async () => {
    const { org, branchA } = await createFixture();
    orgId = org.id;

    const manager = await createUser({
      organizationId: org.id,
      firstName: "Valid",
      lastName: "Manager",
      email: `valid-${org.id}@test.local`,
      password: "password123",
      role: "MANAGER",
      branchIds: [branchA.id],
    });

    expect(manager.username).toBe("vmanager");
    expect(manager.email).toBe(`valid-${org.id}@test.local`);
  });
});
