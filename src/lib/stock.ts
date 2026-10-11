import {
  MovementType,
  Prisma,
  type PrismaClient,
} from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";
import { prisma } from "@/lib/prisma";
import {
  classifyStock,
  queueStockTransition,
} from "@/lib/integrationEvents";

type Tx = Prisma.TransactionClient | PrismaClient;

export class StockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StockError";
  }
}

export type ApplyMovementInput = {
  branchId: string;
  ingredientId: string;
  /** Signed delta: positive increases stock, negative decreases */
  delta: Prisma.Decimal | number | string;
  type: MovementType;
  refType?: string;
  refId?: string;
  note?: string;
  createdById?: string;
  /** When false, reject if resulting qty would be negative */
  allowNegative?: boolean;
};

function toDecimal(value: Prisma.Decimal | number | string): Decimal {
  return value instanceof Decimal ? value : new Decimal(value);
}

/**
 * Single write path for all stock changes.
 * Upserts StockItem balance and appends StockMovement ledger row.
 */
export async function applyMovement(
  input: ApplyMovementInput,
  client: Tx = prisma,
) {
  const delta = toDecimal(input.delta);
  if (delta.isZero()) {
    throw new StockError("Movement quantity cannot be zero");
  }

  // Serializes concurrent movements on the same (branch, ingredient) so the
  // read-then-write below can't race across two overlapping transactions.
  // Callers always invoke this inside prisma.$transaction, so the lock is
  // held for the transaction's lifetime and released automatically at commit/rollback.
  await lockStockItem(client, input.branchId, input.ingredientId);

  const [existing, ingredient, branch] = await Promise.all([
    client.stockItem.findUnique({
      where: {
        branchId_ingredientId: {
          branchId: input.branchId,
          ingredientId: input.ingredientId,
        },
      },
    }),
    client.ingredient.findUnique({ where: { id: input.ingredientId } }),
    client.branch.findUnique({ where: { id: input.branchId } }),
  ]);

  if (!ingredient || !branch || ingredient.organizationId !== branch.organizationId) {
    throw new StockError("Ingredient or branch not found");
  }

  const current = existing ? toDecimal(existing.quantity) : new Decimal(0);
  const next = current.plus(delta);
  const lowStockAt = existing
    ? toDecimal(existing.lowStockAt)
    : toDecimal(ingredient.defaultLowStockAt ?? 0);
  const previousState = existing
    ? classifyStock(current, existing.lowStockAt)
    : "NORMAL";

  if (!input.allowNegative && next.isNegative()) {
    throw new StockError(
      `Insufficient stock for ingredient ${input.ingredientId} at branch ${input.branchId}`,
    );
  }

  const stockItem = await client.stockItem.upsert({
    where: {
      branchId_ingredientId: {
        branchId: input.branchId,
        ingredientId: input.ingredientId,
      },
    },
    create: {
      branchId: input.branchId,
      ingredientId: input.ingredientId,
      quantity: next,
      lowStockAt,
    },
    update: {
      quantity: next,
    },
  });

  const movement = await client.stockMovement.create({
    data: {
      branchId: input.branchId,
      ingredientId: input.ingredientId,
      type: input.type,
      quantity: delta,
      balanceAfter: next,
      refType: input.refType,
      refId: input.refId,
      note: input.note,
      createdById: input.createdById,
    },
  });

  await queueStockTransition(client, {
    organizationId: branch.organizationId,
    branchId: branch.id,
    branchCode: branch.code,
    branchName: branch.name,
    ingredientId: ingredient.id,
    ingredientName: ingredient.name,
    unit: ingredient.unit,
    previousState,
    nextState: classifyStock(next, lowStockAt),
    quantity: next,
    lowStockAt,
    parLevel: stockItem.parLevel,
    causeKey: movement.id,
  });

  return { stockItem, movement };
}

/**
 * Serializes concurrent changes to one (branch, ingredient). Only holds for
 * the life of an active transaction, so callers must be inside one. Exported
 * so multi-step operations (warehouse count import) can take the lock up front,
 * read a fresh balance, and then call applyMovement without racing anyone.
 */
export async function lockStockItem(client: Tx, branchId: string, ingredientId: string) {
  await client.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${branchId} || ':' || ${ingredientId}))`;
}

/** Pass `client` to compose into a larger transaction; omit it to run standalone. */
export async function setStockPolicy(
  params: {
    organizationId: string;
    branchId: string;
    ingredientId: string;
    lowStockAt: Prisma.Decimal | number | string;
    parLevel?: Prisma.Decimal | number | string | null;
  },
  client?: Tx,
) {
  const lowStockAt = toDecimal(params.lowStockAt);
  const parLevel = params.parLevel === null || params.parLevel === undefined
    ? null
    : toDecimal(params.parLevel);
  if (lowStockAt.isNegative()) throw new StockError("Low-stock threshold cannot be negative");
  if (parLevel && parLevel.lessThan(lowStockAt)) {
    throw new StockError("Par level must be at or above the low-stock threshold");
  }

  const run = async (tx: Tx) => {
    const [branch, ingredient, existing] = await Promise.all([
      tx.branch.findFirst({ where: { id: params.branchId, organizationId: params.organizationId } }),
      tx.ingredient.findFirst({ where: { id: params.ingredientId, organizationId: params.organizationId } }),
      tx.stockItem.findUnique({
        where: { branchId_ingredientId: { branchId: params.branchId, ingredientId: params.ingredientId } },
      }),
    ]);
    if (!branch || !ingredient) throw new StockError("Ingredient or branch not found");

    const stockItem = await tx.stockItem.upsert({
      where: { branchId_ingredientId: { branchId: params.branchId, ingredientId: params.ingredientId } },
      create: {
        branchId: params.branchId,
        ingredientId: params.ingredientId,
        quantity: new Decimal(0),
        lowStockAt,
        parLevel,
      },
      update: { lowStockAt, parLevel },
    });

    if (existing) {
      await queueStockTransition(tx, {
        organizationId: branch.organizationId,
        branchId: branch.id,
        branchCode: branch.code,
        branchName: branch.name,
        ingredientId: ingredient.id,
        ingredientName: ingredient.name,
        unit: ingredient.unit,
        previousState: classifyStock(existing.quantity, existing.lowStockAt),
        nextState: classifyStock(stockItem.quantity, stockItem.lowStockAt),
        quantity: stockItem.quantity,
        lowStockAt: stockItem.lowStockAt,
        parLevel: stockItem.parLevel,
        causeKey: `policy:${crypto.randomUUID()}`,
      });
    }
    return stockItem;
  };

  if (client) return run(client);
  return prisma.$transaction(run);
}

export async function getLowStockItems(branchIds: string[]) {
  const items = await prisma.stockItem.findMany({
    where: { branchId: { in: branchIds } },
    include: {
      ingredient: true,
      branch: true,
    },
    orderBy: [{ branchId: "asc" }, { ingredientId: "asc" }],
  });

  return items.filter((item) => {
    const qty = toDecimal(item.quantity);
    const low = toDecimal(item.lowStockAt);
    return qty.lessThanOrEqualTo(low);
  });
}

/**
 * Splits low-stock items into "critical" (at or below zero — actually out)
 * vs. "low" (above zero but at/under threshold), and reports how many
 * StockItem rows exist at all in scope. That last count matters: zero tracked
 * rows means opening counts were never entered (nothing to alert on yet), not
 * that everything is healthy — callers should show those two states
 * differently instead of both rendering as "0 low stock items".
 */
export async function getStockAlertSummary(branchIds: string[]) {
  const items = await prisma.stockItem.findMany({
    where: { branchId: { in: branchIds } },
    include: { ingredient: true, branch: true },
  });

  const critical: typeof items = [];
  const low: typeof items = [];
  for (const item of items) {
    const qty = toDecimal(item.quantity);
    const lowAt = toDecimal(item.lowStockAt);
    if (qty.lessThanOrEqualTo(0)) critical.push(item);
    else if (qty.lessThanOrEqualTo(lowAt)) low.push(item);
  }

  const sortByUrgency = (a: (typeof items)[number], b: (typeof items)[number]) =>
    toDecimal(a.quantity).minus(toDecimal(a.lowStockAt)).comparedTo(toDecimal(b.quantity).minus(toDecimal(b.lowStockAt)));

  return {
    trackedCount: items.length,
    critical: critical.sort(sortByUrgency),
    low: low.sort(sortByUrgency),
  };
}

export { MovementType };
