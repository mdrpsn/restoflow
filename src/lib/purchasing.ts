import { MovementType, PurchaseOrderStatus } from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";
import { prisma } from "@/lib/prisma";
import { applyMovement, StockError } from "@/lib/stock";

export async function receivePurchaseOrder(params: {
  purchaseOrderId: string;
  organizationId: string;
  userId: string;
  receipts: { lineId: string; quantity: number | string }[];
}) {
  return prisma.$transaction(async (tx) => {
    const po = await tx.purchaseOrder.findFirst({
      where: {
        id: params.purchaseOrderId,
        organizationId: params.organizationId,
      },
      include: { lines: true },
    });
    if (!po) throw new StockError("Purchase order not found");
    if (
      po.status === PurchaseOrderStatus.CANCELLED ||
      po.status === PurchaseOrderStatus.DRAFT
    ) {
      throw new StockError("PO cannot be received in its current status");
    }

    const lineMap = new Map(po.lines.map((l) => [l.id, l]));

    for (const receipt of params.receipts) {
      const qty = new Decimal(receipt.quantity);
      if (qty.lessThanOrEqualTo(0)) continue;
      const line = lineMap.get(receipt.lineId);
      if (!line) throw new StockError("Invalid PO line");

      const remaining = new Decimal(line.quantityOrdered).minus(line.quantityReceived);
      if (qty.greaterThan(remaining)) {
        throw new StockError(`Cannot receive more than remaining for ${line.id}`);
      }

      // Atomic conditional increment: quantityOrdered never changes after
      // creation, so it's safe to use as a literal ceiling here. The `lte`
      // guard is re-evaluated by Postgres against the row's *current*
      // committed value at UPDATE time (row-locked for the duration), so two
      // concurrent receipts on the same line can't both pass a stale
      // "remaining" check the way two independent read-then-write calls
      // could — the loser's updateMany matches 0 rows and fails loudly
      // instead of silently allowing the PO to be over-received.
      const maxQuantityReceivedBeforeThis = new Decimal(line.quantityOrdered).minus(qty);
      const claimed = await tx.purchaseOrderLine.updateMany({
        where: { id: line.id, quantityReceived: { lte: maxQuantityReceivedBeforeThis } },
        data: { quantityReceived: { increment: qty } },
      });
      if (claimed.count === 0) {
        throw new StockError(`Cannot receive more than remaining for ${line.id}`);
      }

      await applyMovement(
        {
          branchId: po.branchId,
          ingredientId: line.ingredientId,
          delta: qty,
          type: MovementType.PO_RECEIVE,
          refType: "purchase_order",
          refId: po.id,
          createdById: params.userId,
          allowNegative: true,
        },
        tx,
      );
    }

    const refreshed = await tx.purchaseOrderLine.findMany({
      where: { purchaseOrderId: po.id },
    });

    const allReceived = refreshed.every((l) =>
      new Decimal(l.quantityReceived).greaterThanOrEqualTo(l.quantityOrdered),
    );
    const anyReceived = refreshed.some((l) =>
      new Decimal(l.quantityReceived).greaterThan(0),
    );

    let status: PurchaseOrderStatus = po.status;
    if (allReceived) status = PurchaseOrderStatus.RECEIVED;
    else if (anyReceived) status = PurchaseOrderStatus.PARTIAL;

    return tx.purchaseOrder.update({
      where: { id: po.id },
      data: {
        status,
        receivedAt: allReceived ? new Date() : po.receivedAt,
      },
      include: { lines: { include: { ingredient: true } }, supplier: true, branch: true },
    });
  });
}

export async function cancelPurchaseOrder(params: {
  purchaseOrderId: string;
  organizationId: string;
  userId: string;
}) {
  return prisma.$transaction(async (tx) => {
    const po = await tx.purchaseOrder.findFirst({
      where: {
        id: params.purchaseOrderId,
        organizationId: params.organizationId,
      },
    });
    if (!po) throw new StockError("Purchase order not found");
    if (
      po.status === PurchaseOrderStatus.RECEIVED ||
      po.status === PurchaseOrderStatus.CANCELLED
    ) {
      throw new StockError("PO cannot be cancelled in its current status");
    }

    // Atomic conditional update, guarded by the exact status just read, so a
    // concurrent receive (which can change PARTIAL -> RECEIVED, or ORDERED ->
    // PARTIAL) can't race with this and leave the PO's status field wrong —
    // the underlying stock is already independently safe either way.
    const claimed = await tx.purchaseOrder.updateMany({
      where: { id: po.id, status: po.status },
      data: {
        status: PurchaseOrderStatus.CANCELLED,
        cancelledById: params.userId,
        cancelledAt: new Date(),
      },
    });
    if (claimed.count === 0) {
      throw new StockError("PO status changed concurrently; please retry");
    }

    // Cancelling only stops further receiving on this PO; any quantity
    // already received (a PARTIAL PO) has physically arrived and stays on
    // the books.
    return tx.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } });
  });
}
