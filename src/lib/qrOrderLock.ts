import type { Prisma } from "@prisma/client";

/** Claim, release, cancel and checkout must all take this lock before reading status. */
export async function lockQrOrder(tx: Prisma.TransactionClient, id: string) {
  await tx.$queryRaw`SELECT id FROM "QrOrder" WHERE id = ${id} FOR UPDATE`;
}
