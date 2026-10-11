import { MovementType, Prisma, StockTransferStatus, type PrismaClient } from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";
import { prisma } from "@/lib/prisma";
import { applyMovement, StockError } from "@/lib/stock";

type Tx = Prisma.TransactionClient | PrismaClient;

/**
 * Creates a transfer in DRAFT status. No stock moves yet — stock only changes
 * when the transfer is shipped (out of the source) and received (into the
 * destination), via shipTransfer/receiveTransfer below.
 */
export async function createTransfer(
  params: {
    organizationId: string;
    fromBranchId: string;
    toBranchId: string;
    createdById: string;
    note?: string;
    /**
     * `quantity` is in the ingredient's base unit, unless `packId` is given: then it is a
     * count of that pack and is converted here (never trusted from the client) into base units.
     */
    lines: { ingredientId: string; quantity: number | string; packId?: string | null }[];
  },
  client: Tx = prisma,
) {
  if (params.fromBranchId === params.toBranchId) {
    throw new StockError("Cannot transfer to the same branch");
  }
  if (params.lines.length === 0) throw new StockError("Transfer has no lines");
  for (const line of params.lines) {
    if (new Decimal(line.quantity).lessThanOrEqualTo(0)) {
      throw new StockError("Transfer line quantities must be positive");
    }
  }
  const ingredientIds = params.lines.map((l) => l.ingredientId);
  if (new Set(ingredientIds).size !== ingredientIds.length) {
    throw new StockError("Transfer has the same ingredient on more than one line");
  }

  const branches = await client.branch.findMany({
    where: {
      organizationId: params.organizationId,
      id: { in: [params.fromBranchId, params.toBranchId] },
    },
  });
  if (branches.length !== 2) throw new StockError("Invalid branches");

  const packIds = params.lines.map((l) => l.packId).filter((id): id is string => !!id);
  const packs = packIds.length
    ? await client.ingredientPack.findMany({
        where: { id: { in: packIds }, ingredient: { organizationId: params.organizationId } },
      })
    : [];
  const packById = new Map(packs.map((p) => [p.id, p]));

  const lineData = params.lines.map((l) => {
    if (!l.packId) return { ingredientId: l.ingredientId, quantity: new Decimal(l.quantity) };
    const pack = packById.get(l.packId);
    if (!pack || pack.ingredientId !== l.ingredientId) {
      throw new StockError("That pack doesn't belong to the selected ingredient");
    }
    const count = new Decimal(l.quantity);
    return {
      ingredientId: l.ingredientId,
      quantity: count.mul(pack.size),
      packLabel: pack.name,
      packQuantity: count,
    };
  });

  return client.stockTransfer.create({
    data: {
      fromBranchId: params.fromBranchId,
      toBranchId: params.toBranchId,
      note: params.note,
      createdById: params.createdById,
      status: StockTransferStatus.DRAFT,
      lines: { create: lineData },
    },
    include: { lines: true },
  });
}

async function loadTransferForOrg(tx: Tx, transferId: string, organizationId: string) {
  const transfer = await tx.stockTransfer.findFirst({
    where: {
      id: transferId,
      fromBranch: { organizationId },
    },
    include: { lines: true },
  });
  if (!transfer) throw new StockError("Transfer not found");
  return transfer;
}

/**
 * Atomically claims a transfer's status transition: only succeeds if the
 * transfer is still in `from` status at the moment of the UPDATE itself
 * (Postgres row-locks the row for the duration of the UPDATE, so a
 * concurrent claim on the same row necessarily serializes behind it and
 * re-evaluates against the committed result). This is what makes
 * ship/receive/cancel safe under concurrent/duplicate requests — the
 * plain "read status, then decide, then write" pattern this replaced was
 * not: two overlapping calls could both read the old status before either
 * committed and both proceed to apply movements, deducting or crediting
 * stock twice for one action.
 */
async function claimTransferStatus(
  tx: Tx,
  transferId: string,
  from: StockTransferStatus,
  data: Prisma.StockTransferUncheckedUpdateManyInput,
) {
  const claimed = await tx.stockTransfer.updateMany({
    where: { id: transferId, status: from },
    data,
  });
  if (claimed.count === 0) {
    throw new StockError(
      `Transfer is no longer in ${from} status (changed by a concurrent action)`,
    );
  }
}

/** DRAFT -> IN_TRANSIT. Deducts stock from the source branch. */
export async function shipTransfer(params: {
  transferId: string;
  organizationId: string;
  userId: string;
}) {
  return prisma.$transaction(async (tx) => {
    const transfer = await loadTransferForOrg(tx, params.transferId, params.organizationId);
    if (transfer.status !== StockTransferStatus.DRAFT) {
      throw new StockError("Transfer must be in DRAFT status to ship");
    }

    await claimTransferStatus(tx, transfer.id, StockTransferStatus.DRAFT, {
      status: StockTransferStatus.IN_TRANSIT,
      shippedAt: new Date(),
      shippedById: params.userId,
    });

    for (const line of transfer.lines) {
      await applyMovement(
        {
          branchId: transfer.fromBranchId,
          ingredientId: line.ingredientId,
          delta: new Decimal(line.quantity).neg(),
          type: MovementType.TRANSFER_OUT,
          refType: "transfer",
          refId: transfer.id,
          createdById: params.userId,
        },
        tx,
      );
    }

    return tx.stockTransfer.findUniqueOrThrow({ where: { id: transfer.id } });
  });
}

/** IN_TRANSIT -> RECEIVED. Adds stock to the destination branch. */
export async function receiveTransfer(params: {
  transferId: string;
  organizationId: string;
  userId: string;
}) {
  return prisma.$transaction(async (tx) => {
    const transfer = await loadTransferForOrg(tx, params.transferId, params.organizationId);
    if (transfer.status !== StockTransferStatus.IN_TRANSIT) {
      throw new StockError("Transfer must be IN_TRANSIT to receive");
    }

    await claimTransferStatus(tx, transfer.id, StockTransferStatus.IN_TRANSIT, {
      status: StockTransferStatus.RECEIVED,
      receivedAt: new Date(),
      receivedById: params.userId,
    });

    for (const line of transfer.lines) {
      await applyMovement(
        {
          branchId: transfer.toBranchId,
          ingredientId: line.ingredientId,
          delta: new Decimal(line.quantity),
          type: MovementType.TRANSFER_IN,
          refType: "transfer",
          refId: transfer.id,
          createdById: params.userId,
          allowNegative: true,
        },
        tx,
      );
    }

    return tx.stockTransfer.findUniqueOrThrow({ where: { id: transfer.id } });
  });
}

/**
 * Cancels a transfer. From DRAFT: no stock impact. From IN_TRANSIT: reverses
 * the shipment (stock already left the source) with an explicit
 * TRANSFER_CANCEL ledger entry, so the ledger stays self-explanatory instead
 * of masquerading a cancellation as a generic adjustment.
 */
export async function cancelTransfer(params: {
  transferId: string;
  organizationId: string;
  userId: string;
}) {
  return prisma.$transaction(async (tx) => {
    const transfer = await loadTransferForOrg(tx, params.transferId, params.organizationId);
    if (
      transfer.status === StockTransferStatus.RECEIVED ||
      transfer.status === StockTransferStatus.CANCELLED
    ) {
      throw new StockError("Transfer cannot be cancelled in its current status");
    }

    const wasInTransit = transfer.status === StockTransferStatus.IN_TRANSIT;
    await claimTransferStatus(tx, transfer.id, transfer.status, {
      status: StockTransferStatus.CANCELLED,
      cancelledAt: new Date(),
      cancelledById: params.userId,
    });

    if (wasInTransit) {
      for (const line of transfer.lines) {
        await applyMovement(
          {
            branchId: transfer.fromBranchId,
            ingredientId: line.ingredientId,
            delta: new Decimal(line.quantity),
            type: MovementType.TRANSFER_CANCEL,
            refType: "transfer",
            refId: transfer.id,
            createdById: params.userId,
            allowNegative: true,
          },
          tx,
        );
      }
    }

    return tx.stockTransfer.findUniqueOrThrow({ where: { id: transfer.id } });
  });
}

export async function receiveStock(params: {
  branchId: string;
  createdById: string;
  /** With `packId`, `quantity` is a count of that pack and is converted to base units here. */
  lines: { ingredientId: string; quantity: number | string; packId?: string | null; note?: string }[];
}) {
  if (params.lines.length === 0) throw new StockError("Nothing to receive");

  return prisma.$transaction(async (tx) => {
    const results = [];
    for (const line of params.lines) {
      let qty = new Decimal(line.quantity);
      if (qty.lessThanOrEqualTo(0)) throw new StockError("Receive qty must be positive");
      let note = line.note;
      if (line.packId) {
        const pack = await tx.ingredientPack.findUnique({ where: { id: line.packId } });
        if (!pack || pack.ingredientId !== line.ingredientId) {
          throw new StockError("That pack doesn't belong to the selected ingredient");
        }
        note = [`${qty.toString()} × ${pack.name}`, line.note].filter(Boolean).join(" — ");
        qty = qty.mul(pack.size);
      }
      results.push(
        await applyMovement(
          {
            branchId: params.branchId,
            ingredientId: line.ingredientId,
            delta: qty,
            type: MovementType.RECEIVE,
            refType: "receive",
            createdById: params.createdById,
            note,
            allowNegative: true,
          },
          tx,
        ),
      );
    }
    return results;
  });
}

/**
 * When called standalone (no `client`), wraps itself in its own transaction
 * so applyMovement's advisory lock holds for the full read-then-write (a
 * lock only holds for the life of an active transaction — without one, each
 * statement is its own implicit transaction and the lock is released
 * immediately, giving no protection). When composing into a larger atomic
 * operation (e.g. a cycle count adjusting many ingredients at once), pass
 * that operation's own `tx` so all the adjustments commit or fail together.
 */
export async function adjustStock(
  params: {
    branchId: string;
    ingredientId: string;
    newQuantity: number | string;
    createdById: string;
    note?: string;
    refType?: string;
    refId?: string;
  },
  client?: Tx,
) {
  const next = new Decimal(params.newQuantity);
  if (next.isNegative()) {
    throw new StockError("On-hand quantity cannot be set to a negative amount");
  }

  const run = async (tx: Tx) => {
    const item = await tx.stockItem.findUnique({
      where: {
        branchId_ingredientId: {
          branchId: params.branchId,
          ingredientId: params.ingredientId,
        },
      },
    });
    const current = item ? new Decimal(item.quantity) : new Decimal(0);
    const delta = next.minus(current);
    if (delta.isZero()) return item;

    return applyMovement(
      {
        branchId: params.branchId,
        ingredientId: params.ingredientId,
        delta,
        type: MovementType.ADJUSTMENT,
        refType: params.refType ?? "adjustment",
        refId: params.refId,
        createdById: params.createdById,
        note: params.note,
        allowNegative: true,
      },
      tx,
    );
  };

  if (client) return run(client);
  return prisma.$transaction(run);
}

/**
 * Logs waste/spoilage as its own movement type, distinct from ADJUSTMENT —
 * so a waste report can be built on real, purpose-built data instead of
 * guessing at free-text adjustment notes. Cannot waste more than is on hand.
 */
export async function logWaste(params: {
  branchId: string;
  ingredientId: string;
  quantity: number | string;
  reason: string;
  createdById: string;
}) {
  const qty = new Decimal(params.quantity);
  if (qty.lessThanOrEqualTo(0)) throw new StockError("Waste quantity must be positive");

  return prisma.$transaction(async (tx) => {
    const result = await applyMovement(
      {
        branchId: params.branchId,
        ingredientId: params.ingredientId,
        delta: qty.neg(),
        type: MovementType.WASTE,
        refType: "waste",
        createdById: params.createdById,
        note: params.reason,
        allowNegative: false,
      },
      tx,
    );
    return result;
  });
}

export type CycleCountResult = {
  batchId: string;
  lines: {
    ingredientId: string;
    previousQuantity: string;
    countedQuantity: string;
    delta: string;
  }[];
};

/**
 * Submits a full physical count for a branch as one atomic batch: every
 * line goes through adjustStock (reusing its existing non-negative guard
 * and no-op-on-unchanged behavior), sharing one refId so the resulting
 * ADJUSTMENT movements are identifiable afterward as one count — in the
 * activity log and the variance report — instead of N unrelated one-off
 * corrections. All-or-nothing: if any line fails, the whole count rolls back.
 */
export async function runCycleCount(params: {
  branchId: string;
  createdById: string;
  counts: { ingredientId: string; countedQuantity: number | string }[];
}): Promise<CycleCountResult> {
  if (params.counts.length === 0) throw new StockError("Cycle count has no lines");

  const batchId = crypto.randomUUID();

  return prisma.$transaction(async (tx) => {
    const lines: CycleCountResult["lines"] = [];
    for (const count of params.counts) {
      const before = await tx.stockItem.findUnique({
        where: {
          branchId_ingredientId: { branchId: params.branchId, ingredientId: count.ingredientId },
        },
      });
      const previousQuantity = before ? new Decimal(before.quantity) : new Decimal(0);
      const countedQuantity = new Decimal(count.countedQuantity);

      await adjustStock(
        {
          branchId: params.branchId,
          ingredientId: count.ingredientId,
          newQuantity: countedQuantity.toString(),
          createdById: params.createdById,
          note: "Cycle count",
          refType: "cycle_count",
          refId: batchId,
        },
        tx,
      );

      lines.push({
        ingredientId: count.ingredientId,
        previousQuantity: previousQuantity.toString(),
        countedQuantity: countedQuantity.toString(),
        delta: countedQuantity.minus(previousQuantity).toString(),
      });
    }
    return { batchId, lines };
  });
}
