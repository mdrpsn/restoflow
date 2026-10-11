import { afterEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { submitQrOrder, claimQrOrder, cancelQrOrder, releaseQrOrder, listPendingQrOrders } from "@/lib/qrOrders";
import { completeSale, voidSale } from "@/lib/sales";
import { createFixture, cleanupFixture } from "./testFixture";

describe("QR order lifecycle", () => {
  let orgId: string | null = null;
  afterEach(async () => { if (orgId) await cleanupFixture(orgId); orgId = null; });
  async function fixture() {
    const data = await createFixture();
    orgId = data.org.id;
    const other = await prisma.user.create({ data: { organizationId: data.org.id, name: "Second cashier", passwordHash: "unused" } });
    await prisma.stockItem.create({ data: { branchId: data.branchA.id, ingredientId: data.ingredient.id, quantity: 20 } });
    const input = { branchId: data.branchA.id, customerName: "  Guest  ", note: "No ice", lines: [{ productId: data.product.id, quantity: 2 }] };
    const saleInput = { organizationId: data.org.id, branchId: data.branchA.id, cashierId: data.cashier.id, paymentMethod: "CASH" as const, lines: input.lines };
    return { ...data, other, input, saleInput };
  }

  it("prices orders on the server and leaves stock alone until checkout", async () => {
    const { input, branchA, ingredient } = await fixture();
    const order = await submitQrOrder(input);
    expect(order.totalCents).toBe(1000);
    expect((await listPendingQrOrders(branchA.id))[0].customerName).toBe("Guest");
    expect((await prisma.stockItem.findUniqueOrThrow({ where: { branchId_ingredientId: { branchId: branchA.id, ingredientId: ingredient.id } } })).quantity.toString()).toBe("20");
  });

  it("rejects fractional, non-finite and excessive quantities before saving", async () => {
    const { input, product, saleInput } = await fixture();
    for (const quantity of [0, -1, 1.5, NaN, Infinity, 1000]) {
      const lines = [{ productId: product.id, quantity }];
      await expect(submitQrOrder({ ...input, lines })).rejects.toThrow(/whole item quantities/);
      await expect(completeSale({ ...saleInput, lines })).rejects.toThrow(/whole item quantities/);
    }
  });

  it("lets only one of two cashiers claim an order, and lets that cashier resume", async () => {
    const { input, cashier, other, branchA } = await fixture();
    const order = await submitQrOrder(input);
    const results = await Promise.allSettled([claimQrOrder(order.id, cashier.id, branchA.id), claimQrOrder(order.id, other.id, branchA.id)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const saved = await prisma.qrOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect((await claimQrOrder(order.id, saved.claimedById!, branchA.id)).cartLines).toEqual(input.lines.map(line => ({ ...line, modifiers: undefined })));
    expect((await listPendingQrOrders(branchA.id))[0].status).toBe("CLAIMED");
  });

  it("cannot claim or release another branch's order", async () => {
    const { input, cashier, branchA, branchB } = await fixture();
    const order = await submitQrOrder(input);
    await expect(claimQrOrder(order.id, cashier.id, branchB.id)).rejects.toThrow(/different branch/);
    await claimQrOrder(order.id, cashier.id, branchA.id);
    await expect(releaseQrOrder(order.id, cashier.id, branchB.id, true)).rejects.toThrow(/not found/);
  });

  it("protects claims from other cashiers and allows manager recovery", async () => {
    const { input, cashier, other, branchA } = await fixture();
    const order = await submitQrOrder(input);
    await claimQrOrder(order.id, cashier.id, branchA.id);
    await expect(releaseQrOrder(order.id, other.id, branchA.id)).rejects.toThrow(/cashier handling/);
    await releaseQrOrder(order.id, other.id, branchA.id, true);
    expect((await claimQrOrder(order.id, other.id, branchA.id)).id).toBe(order.id);
  });

  it("prevents cancellation racing with a claim", async () => {
    const { input, cashier, branchA } = await fixture();
    const order = await submitQrOrder(input);
    const results = await Promise.allSettled([claimQrOrder(order.id, cashier.id, branchA.id), cancelQrOrder(order.id, branchA.id)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  });

  it("links checkout to the order and retries without duplicate sales or stock deductions", async () => {
    const { input, cashier, branchA, saleInput, ingredient } = await fixture();
    const order = await submitQrOrder(input);
    await claimQrOrder(order.id, cashier.id, branchA.id);
    const [first, retry] = await Promise.all([completeSale({ ...saleInput, qrOrderId: order.id }), completeSale({ ...saleInput, qrOrderId: order.id })]);
    expect(first.id).toBe(retry.id);
    expect(first.note).toContain("No ice");
    const saved = await prisma.qrOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(saved.status).toBe("COMPLETED");
    expect(saved.saleId).toBe(first.id);
    expect(saved.completedAt).not.toBeNull();
    expect(await listPendingQrOrders(branchA.id)).toHaveLength(0);
    expect((await prisma.stockItem.findUniqueOrThrow({ where: { branchId_ingredientId: { branchId: branchA.id, ingredientId: ingredient.id } } })).quantity.toString()).toBe("16");
  });

  it("keeps failed checkout recoverable and rejects checkout by another cashier", async () => {
    const { input, cashier, other, branchA, saleInput } = await fixture();
    const order = await submitQrOrder(input);
    await claimQrOrder(order.id, cashier.id, branchA.id);
    await expect(completeSale({ ...saleInput, cashierId: other.id, qrOrderId: order.id })).rejects.toThrow(/Claim this QR order/);
    await expect(completeSale({ ...saleInput, qrOrderId: order.id, lines: input.lines.map(line => ({ ...line, quantity: 100 })) })).rejects.toThrow();
    const saved = await prisma.qrOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(saved.status).toBe("CLAIMED");
    expect(saved.saleId).toBeNull();
    expect(await prisma.sale.count({ where: { branchId: branchA.id } })).toBe(0);
  });

  it("cannot return an order to the queue while also completing checkout", async () => {
    const { input, cashier, branchA, saleInput } = await fixture();
    const order = await submitQrOrder(input);
    await claimQrOrder(order.id, cashier.id, branchA.id);
    const results = await Promise.allSettled([releaseQrOrder(order.id, cashier.id, branchA.id), completeSale({ ...saleInput, qrOrderId: order.id })]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  });

  it("does not reopen legacy claims that may already have been paid", async () => {
    const { input, cashier, branchA } = await fixture();
    const order = await submitQrOrder(input);
    await prisma.qrOrder.update({ where: { id: order.id }, data: { status: "CLAIMED", claimedById: cashier.id } });
    expect(await listPendingQrOrders(branchA.id)).toHaveLength(0);
    await expect(claimQrOrder(order.id, cashier.id, branchA.id)).rejects.toThrow(/already claimed/);
  });

  it("restores stock only once when two void requests race", async () => {
    const { saleInput, cashier, org, branchA, ingredient } = await fixture();
    const sale = await completeSale(saleInput);
    const request = { saleId: sale.id, organizationId: org.id, userId: cashier.id };
    const results = await Promise.allSettled([voidSale(request), voidSale(request)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect((await prisma.stockItem.findUniqueOrThrow({ where: { branchId_ingredientId: { branchId: branchA.id, ingredientId: ingredient.id } } })).quantity.toString()).toBe("20");
    expect(await prisma.stockMovement.count({ where: { refId: sale.id, type: "SALE_VOID" } })).toBe(1);
  });
});
