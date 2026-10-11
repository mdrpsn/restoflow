import { prisma } from "@/lib/prisma";

/**
 * Each test gets its own Organization so tests can run against a shared
 * database (even a real dev DB) without wiping or colliding with other data.
 * Deleting the org cascades to every row created under it.
 */
export async function createFixture() {
  const org = await prisma.organization.create({
    data: { name: `test-org-${Date.now()}-${Math.random().toString(36).slice(2)}` },
  });
  const branchA = await prisma.branch.create({
    data: { organizationId: org.id, name: "Branch A", code: "A" },
  });
  const branchB = await prisma.branch.create({
    data: { organizationId: org.id, name: "Branch B", code: "B" },
  });
  const cashier = await prisma.user.create({
    data: {
      organizationId: org.id,
      email: `cashier-${org.id}@test.local`,
      name: "Test Cashier",
      passwordHash: "unused",
      role: "CASHIER",
    },
  });
  const ingredient = await prisma.ingredient.create({
    data: {
      organizationId: org.id,
      name: "Test Ingredient",
      unit: "pcs",
      costCentsPerUnit: 50,
    },
  });
  const product = await prisma.product.create({
    data: {
      organizationId: org.id,
      name: "Test Product",
      priceCents: 500,
      recipeLines: {
        create: [{ ingredientId: ingredient.id, quantity: 2 }],
      },
    },
  });
  const supplier = await prisma.supplier.create({
    data: { organizationId: org.id, name: "Test Supplier" },
  });

  return { org, branchA, branchB, cashier, ingredient, product, supplier };
}

export async function cleanupFixture(orgId: string) {
  const branchFilter = { branch: { organizationId: orgId } };
  await prisma.integrationMutation.deleteMany({ where: { organizationId: orgId } });
  await prisma.integrationEvent.deleteMany({ where: { organizationId: orgId } });
  await prisma.stockMovement.deleteMany({ where: branchFilter });
  await prisma.qrOrder.deleteMany({ where: branchFilter });
  await prisma.saleLine.deleteMany({ where: { sale: branchFilter } });
  await prisma.sale.deleteMany({ where: branchFilter });
  await prisma.stockTransferLine.deleteMany({
    where: { transfer: { fromBranch: { organizationId: orgId } } },
  });
  await prisma.stockTransfer.deleteMany({ where: { fromBranch: { organizationId: orgId } } });
  await prisma.purchaseOrderLine.deleteMany({ where: { purchaseOrder: { organizationId: orgId } } });
  await prisma.purchaseOrder.deleteMany({ where: { organizationId: orgId } });
  await prisma.stockRequestLine.deleteMany({
    where: { stockRequest: { organizationId: orgId } },
  });
  await prisma.stockRequest.deleteMany({ where: { organizationId: orgId } });
  await prisma.stockItem.deleteMany({ where: branchFilter });
  await prisma.recipeLine.deleteMany({ where: { product: { organizationId: orgId } } });
  await prisma.product.deleteMany({ where: { organizationId: orgId } });
  await prisma.ingredient.deleteMany({ where: { organizationId: orgId } });
  await prisma.supplier.deleteMany({ where: { organizationId: orgId } });
  await prisma.userBranch.deleteMany({ where: { user: { organizationId: orgId } } });
  await prisma.user.deleteMany({ where: { organizationId: orgId } });
  await prisma.branch.deleteMany({ where: { organizationId: orgId } });
  await prisma.organization.delete({ where: { id: orgId } });
}
