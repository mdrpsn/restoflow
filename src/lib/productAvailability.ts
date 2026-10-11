import { prisma } from "@/lib/prisma";
import { StockError } from "@/lib/stock";

/**
 * Marks a product available/unavailable at one branch. Deliberately open to any
 * POS user (cashier included): the point is that whoever notices they're out of
 * something can pull it from the menu immediately. Rows are kept (not deleted)
 * when re-enabled so updatedAt/updatedById still record who last flipped it.
 */
export async function setProductAvailability(params: {
  organizationId: string;
  branchId: string;
  productId: string;
  available: boolean;
  userId: string;
}) {
  const [branch, product] = await Promise.all([
    prisma.branch.findFirst({
      where: { id: params.branchId, organizationId: params.organizationId },
      select: { type: true },
    }),
    prisma.product.findFirst({
      where: { id: params.productId, organizationId: params.organizationId },
      select: { id: true },
    }),
  ]);
  if (!branch) throw new StockError("Branch not found");
  if (branch.type === "WAREHOUSE") {
    throw new StockError("Warehouses don't sell, so availability doesn't apply");
  }
  if (!product) throw new StockError("Product not found");

  await prisma.productAvailability.upsert({
    where: { branchId_productId: { branchId: params.branchId, productId: params.productId } },
    create: {
      branchId: params.branchId,
      productId: params.productId,
      available: params.available,
      updatedById: params.userId,
    },
    update: { available: params.available, updatedById: params.userId },
  });
}

export async function listUnavailableProductIds(branchId: string): Promise<Set<string>> {
  const rows = await prisma.productAvailability.findMany({
    where: { branchId, available: false },
    select: { productId: true },
  });
  return new Set(rows.map((r) => r.productId));
}
