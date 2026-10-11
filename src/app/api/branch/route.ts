import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { BRANCH_COOKIE } from "@/lib/branch";
import { canAccessBranch } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";

const bodySchema = z.object({ branchId: z.string().min(1) });

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const branch = await prisma.branch.findFirst({
    where: { id: parsed.data.branchId, organizationId: session.user.organizationId },
    select: { id: true },
  });
  if (!branch || !canAccessBranch(session.user, branch.id)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(BRANCH_COOKIE, parsed.data.branchId, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
  });
  return res;
}
