import { Role } from "@prisma/client";
import { hash } from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { z } from "zod";

/** First initial + last name, lowercase, letters/digits only (e.g. "Mike Rupisan" -> "mrupisan"). */
function usernameSeed(firstName: string, lastName: string): string {
  const first = firstName.trim().charAt(0).toLowerCase();
  const last = lastName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  const seed = `${first}${last}`.replace(/[^a-z0-9]/g, "");
  return seed || "user";
}

/** Appends 2, 3, 4... to the seed until it finds one nobody has taken yet. */
async function uniqueUsername(seed: string): Promise<string> {
  let candidate = seed;
  let suffix = 1;
  // Bounded by the org's headcount in practice; this loop only runs at account
  // creation time (rare, admin-only), so a query per attempt is fine.
  while (await prisma.user.findUnique({ where: { username: candidate }, select: { id: true } })) {
    suffix++;
    candidate = `${seed}${suffix}`;
  }
  return candidate;
}

export async function createUser(params: {
  organizationId: string;
  firstName: string;
  lastName: string;
  /** Optional. Owners/managers may still want email login; cashiers created by the
   * owner typically won't have one — they log in with the generated username instead. */
  email?: string;
  password: string;
  role: Role;
  branchIds: string[];
}) {
  const firstName = params.firstName.trim();
  const lastName = params.lastName.trim();
  const name = `${firstName} ${lastName}`.trim();
  const email = params.email?.trim().toLowerCase() || null;
  z.nativeEnum(Role).parse(params.role);
  if (email) z.string().email().parse(email);
  const branchIds = [...new Set(params.branchIds)];
  if (await prisma.branch.count({ where: { id: { in: branchIds }, organizationId: params.organizationId } }) !== branchIds.length) {
    throw new Error("Select branches from your organization");
  }

  if (!firstName || !lastName || params.password.length < 6) {
    throw new Error("First name, last name, and password (6+) required");
  }
  if (params.role !== Role.OWNER && params.branchIds.length === 0) {
    throw new Error("Select at least one branch for this role — managers and cashiers must be assigned explicitly");
  }

  const username = await uniqueUsername(usernameSeed(firstName, lastName));
  const passwordHash = await hash(params.password, 10);
  try {
    const user = await prisma.user.create({
      data: {
        organizationId: params.organizationId,
        name,
        email,
        username,
        passwordHash,
        role: params.role,
        branches:
          params.role === Role.OWNER
            ? undefined
            : { create: branchIds.map((branchId) => ({ branchId })) },
      },
    });
    return { ...user, username };
  } catch (e) {
    if (e && typeof e === "object" && "code" in e && e.code === "P2002") {
      throw new Error(email ? "That email is already in use" : "That username is already in use — try again");
    }
    throw e;
  }
}

const userUpdateSchema = z.object({
  userId: z.string().min(1),
  name: z.string().trim().min(1, "Name is required").max(100),
  email: z.union([z.string().trim().email(), z.literal("")]).optional(),
  role: z.nativeEnum(Role),
  active: z.boolean(),
  branchIds: z.array(z.string().min(1)),
  password: z.union([z.string().min(6, "Password must have at least 6 characters"), z.literal("")]).optional(),
});

export type UserUpdate = z.infer<typeof userUpdateSchema>;

export async function updateUser(organizationId: string, actorId: string, input: UserUpdate) {
  const data = userUpdateSchema.parse(input);
  const branchIds = data.role === Role.OWNER ? [] : [...new Set(data.branchIds)];
  if (data.active && data.role !== Role.OWNER && branchIds.length === 0) {
    throw new Error("Select at least one branch for an active manager or cashier");
  }
  const passwordHash = data.password ? await hash(data.password, 10) : undefined;
  try {
    return await prisma.$transaction(async (tx) => {
      // Serialize account changes so simultaneous edits cannot remove every owner.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`staff:${organizationId}`}))`;
      const actor = await tx.user.findFirst({ where: { id: actorId, organizationId, role: Role.OWNER, active: true } });
      if (!actor) throw new Error("Only an active owner can manage users");
      const user = await tx.user.findFirst({ where: { id: data.userId, organizationId } });
      if (!user) throw new Error("User not found");
      if (!user.username && !data.email?.trim()) throw new Error("This account uses email to sign in; keep an email address");
      if (user.id === actorId && (!data.active || data.role !== Role.OWNER)) {
        throw new Error("Ask another owner to change your own role or deactivate your account");
      }
      if (user.active && user.role === Role.OWNER && (!data.active || data.role !== Role.OWNER)) {
        const owners = await tx.user.count({ where: { organizationId, active: true, role: Role.OWNER, id: { not: user.id } } });
        if (!owners) throw new Error("Keep at least one active owner");
      }
      if (await tx.branch.count({ where: { id: { in: branchIds }, organizationId } }) !== branchIds.length) {
        throw new Error("Select branches from your organization");
      }
      return tx.user.update({
        where: { id: user.id },
        data: {
          name: data.name,
          email: data.email?.trim().toLowerCase() || null,
          role: data.role,
          active: data.active,
          passwordHash,
          sessionVersion: passwordHash || (user.active && !data.active) ? { increment: 1 } : undefined,
          branches: { deleteMany: {}, create: branchIds.map((branchId) => ({ branchId })) },
        },
        select: { id: true },
      });
    });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "P2002") {
      throw new Error("That email is already in use");
    }
    throw error;
  }
}
