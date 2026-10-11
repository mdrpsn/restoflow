import {
  Prisma,
  StockRequestSource,
  StockRequestStatus,
  type PrismaClient,
} from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";
import { prisma } from "@/lib/prisma";
import { StockError } from "@/lib/stock";
import { createTransfer } from "@/lib/transfers";

type Tx = Prisma.TransactionClient | PrismaClient;

async function getWarehouseBranch(organizationId: string, client: Tx) {
  const warehouse = await client.branch.findFirst({
    where: { organizationId, type: "WAREHOUSE" },
  });
  if (!warehouse) throw new StockError("Organization has no warehouse branch configured");
  return warehouse;
}

/**
 * A branch asking the warehouse for stock. Always warehouse-sourced — the
 * requesting branch can't itself be the warehouse, since a warehouse has no
 * further upstream to ask.
 */
export async function createStockRequest(params: {
  organizationId: string;
  branchId: string;
  requestedById: string;
  note?: string;
  lines: { ingredientId: string; quantity: number | string }[];
}) {
  if (params.lines.length === 0) throw new StockError("Request has no lines");
  for (const line of params.lines) {
    if (new Decimal(line.quantity).lessThanOrEqualTo(0)) {
      throw new StockError("Request line quantities must be positive");
    }
  }
  const ingredientIds = params.lines.map((l) => l.ingredientId);
  if (new Set(ingredientIds).size !== ingredientIds.length) {
    throw new StockError("Request has the same ingredient on more than one line");
  }

  const branch = await prisma.branch.findFirst({
    where: { id: params.branchId, organizationId: params.organizationId },
  });
  if (!branch) throw new StockError("Branch not found");
  if (branch.type === "WAREHOUSE") {
    throw new StockError("The warehouse can't request stock from itself");
  }

  return prisma.stockRequest.create({
    data: {
      organizationId: params.organizationId,
      branchId: params.branchId,
      requestedById: params.requestedById,
      source: StockRequestSource.MANUAL,
      note: params.note,
      status: StockRequestStatus.PENDING,
      lines: {
        create: params.lines.map((l) => ({
          ingredientId: l.ingredientId,
          quantity: new Decimal(l.quantity),
        })),
      },
    },
    include: { lines: true },
  });
}

export async function reconcileAutomatedStockRequest(params: {
  organizationId: string;
  branchCode: string;
}) {
  return prisma.$transaction(async (tx) => {
    const branch = await tx.branch.findFirst({
      where: {
        organizationId: params.organizationId,
        code: params.branchCode,
        type: "STORE",
      },
    });
    if (!branch) throw new StockError("Store branch not found");

    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'auto-restock:' + branch.id}))`;

    const tracked = await tx.stockItem.findMany({
      where: { branchId: branch.id, parLevel: { not: null } },
      include: { ingredient: true },
      orderBy: { ingredient: { name: "asc" } },
    });
    const lines = tracked
      .filter((item) => {
        const quantity = new Decimal(item.quantity);
        return quantity.lessThanOrEqualTo(item.lowStockAt) && quantity.lessThan(item.parLevel!);
      })
      .map((item) => ({
        ingredientId: item.ingredientId,
        ingredientName: item.ingredient.name,
        unit: item.ingredient.unit,
        quantity: new Decimal(item.parLevel!).minus(item.quantity).toString(),
      }));

    const automationKey = `auto-replenishment:${branch.id}`;
    const existing = await tx.stockRequest.findUnique({
      where: { automationKey },
      include: { lines: true },
    });

    if (lines.length === 0) {
      if (existing) await tx.stockRequest.delete({ where: { id: existing.id } });
      return { changed: !!existing, branch, draft: null };
    }

    const nextSignature = lines
      .map((line) => `${line.ingredientId}:${line.quantity}`)
      .sort()
      .join("|");
    const currentSignature = existing?.lines
      .map((line) => `${line.ingredientId}:${new Decimal(line.quantity).toString()}`)
      .sort()
      .join("|");

    let draft;
    const changed = !existing || currentSignature !== nextSignature;
    if (!existing) {
      draft = await tx.stockRequest.create({
        data: {
          organizationId: params.organizationId,
          branchId: branch.id,
          status: StockRequestStatus.DRAFT,
          source: StockRequestSource.AUTOMATION,
          automationKey,
          note: "Automatically proposed from low-stock and par-level settings",
          lines: {
            create: lines.map((line) => ({
              ingredientId: line.ingredientId,
              quantity: new Decimal(line.quantity),
            })),
          },
        },
        include: { lines: { include: { ingredient: true } } },
      });
    } else if (changed) {
      await tx.stockRequestLine.deleteMany({ where: { stockRequestId: existing.id } });
      draft = await tx.stockRequest.update({
        where: { id: existing.id },
        data: {
          lines: {
            create: lines.map((line) => ({
              ingredientId: line.ingredientId,
              quantity: new Decimal(line.quantity),
            })),
          },
        },
        include: { lines: { include: { ingredient: true } } },
      });
    } else {
      draft = await tx.stockRequest.findUniqueOrThrow({
        where: { id: existing.id },
        include: { lines: { include: { ingredient: true } } },
      });
    }

    return { changed, branch, draft };
  });
}

export async function submitAutomatedStockRequestDraft(params: {
  requestId: string;
  organizationId: string;
  requestedById: string;
  lines: { ingredientId: string; quantity: number | string }[];
}) {
  if (!params.lines.length) throw new StockError("Draft must contain at least one line");
  const ids = params.lines.map((line) => line.ingredientId);
  if (new Set(ids).size !== ids.length) throw new StockError("Draft has duplicate ingredients");
  for (const line of params.lines) {
    if (new Decimal(line.quantity).lessThanOrEqualTo(0)) {
      throw new StockError("Draft quantities must be positive");
    }
  }

  return prisma.$transaction(async (tx) => {
    const draft = await tx.stockRequest.findFirst({
      where: {
        id: params.requestId,
        organizationId: params.organizationId,
        source: StockRequestSource.AUTOMATION,
        status: StockRequestStatus.DRAFT,
      },
    });
    if (!draft) throw new StockError("Automation draft not found or already submitted");

    const validIngredientCount = await tx.ingredient.count({
      where: { id: { in: ids }, organizationId: params.organizationId },
    });
    if (validIngredientCount !== ids.length) throw new StockError("Draft contains an invalid ingredient");

    await tx.stockRequestLine.deleteMany({ where: { stockRequestId: draft.id } });
    await tx.stockRequestLine.createMany({
      data: params.lines.map((line) => ({
        stockRequestId: draft.id,
        ingredientId: line.ingredientId,
        quantity: new Decimal(line.quantity),
      })),
    });
    return tx.stockRequest.update({
      where: { id: draft.id },
      data: {
        status: StockRequestStatus.PENDING,
        requestedById: params.requestedById,
        automationKey: null,
      },
      include: { lines: true },
    });
  });
}

/**
 * Approves a request, converting it 1:1 into a real DRAFT StockTransfer
 * (warehouse -> requesting branch) so the warehouse side never re-types the
 * branch's line items. `approvedQuantities` lets the reviewer fulfill less
 * than requested per line (e.g. limited stock) — omit a line or set it to 0
 * to drop it from the resulting transfer; at least one line must survive.
 */
export async function approveStockRequest(params: {
  requestId: string;
  organizationId: string;
  reviewerId: string;
  approvedQuantities: Record<string, number | string>;
}) {
  return prisma.$transaction(async (tx) => {
    const request = await tx.stockRequest.findFirst({
      where: { id: params.requestId, organizationId: params.organizationId },
      include: { lines: true },
    });
    if (!request) throw new StockError("Request not found");
    if (request.status !== StockRequestStatus.PENDING) {
      throw new StockError("Request has already been reviewed");
    }

    const warehouse = await getWarehouseBranch(params.organizationId, tx);

    const transferLines: { ingredientId: string; quantity: number | string }[] = [];
    for (const line of request.lines) {
      const raw = params.approvedQuantities[line.ingredientId];
      const approved = raw === undefined ? new Decimal(0) : new Decimal(raw);
      if (approved.isNegative()) {
        throw new StockError("Approved quantity cannot be negative");
      }
      await tx.stockRequestLine.update({
        where: { id: line.id },
        data: { approvedQuantity: approved },
      });
      if (approved.greaterThan(0)) {
        transferLines.push({ ingredientId: line.ingredientId, quantity: approved.toString() });
      }
    }
    if (transferLines.length === 0) {
      throw new StockError("Approve at least one line with a quantity above zero, or reject the request instead");
    }

    const transfer = await createTransfer(
      {
        organizationId: params.organizationId,
        fromBranchId: warehouse.id,
        toBranchId: request.branchId,
        createdById: params.reviewerId,
        note: `From stock request${request.note ? `: ${request.note}` : ""}`,
        lines: transferLines,
      },
      tx,
    );

    return tx.stockRequest.update({
      where: { id: request.id },
      data: {
        status: StockRequestStatus.APPROVED,
        reviewedById: params.reviewerId,
        reviewedAt: new Date(),
        transferId: transfer.id,
      },
      include: { lines: true },
    });
  });
}

export async function rejectStockRequest(params: {
  requestId: string;
  organizationId: string;
  reviewerId: string;
  reason?: string;
}) {
  const claimed = await prisma.stockRequest.updateMany({
    where: { id: params.requestId, organizationId: params.organizationId, status: StockRequestStatus.PENDING },
    data: {
      status: StockRequestStatus.REJECTED,
      reviewedById: params.reviewerId,
      reviewedAt: new Date(),
      rejectionReason: params.reason,
    },
  });
  if (claimed.count === 0) {
    throw new StockError("Request not found or already reviewed");
  }
}
