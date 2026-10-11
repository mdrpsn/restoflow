import { createHash } from "crypto";
import { MovementType, Prisma } from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";
import { prisma } from "@/lib/prisma";
import { applyMovement, lockStockItem, setStockPolicy, StockError } from "@/lib/stock";
import {
  MAX_IMPORT_BYTES,
  buildPlan,
  computeRowSteps,
  dayRangeUtc,
  parseWarehouseSheet,
  todayInBusinessTz,
  type IngredientRef,
  type Plan,
  type StepKind,
  type StockSnapshot,
  type SystemDay,
} from "@/lib/warehouseImportCore";

const LOGGED_TYPES = [
  MovementType.RECEIVE,
  MovementType.PO_RECEIVE,
  MovementType.WASTE,
  MovementType.TRANSFER_OUT,
];

export type PreviousImport = { fileName: string; importedBy: string | null; createdAt: string };

export type ImportPreview = {
  fileName: string;
  fileHash: string;
  plan: Plan;
  previousImportsForDate: PreviousImport[];
};

export type ImportSummary = {
  importId: string;
  rowsApplied: number;
  rowsSkipped: number;
  rowsUnchanged: number;
  movements: Record<StepKind, number>;
  policiesSet: number;
};

type Tx = Prisma.TransactionClient;

function foldDay(
  target: Map<string, SystemDay>,
  rows: { ingredientId: string; type: MovementType; quantity: Decimal | null }[],
) {
  for (const row of rows) {
    const cur = target.get(row.ingredientId) ?? { received: "0", wasted: "0", transferredOut: "0" };
    const qty = new Decimal(row.quantity ?? 0);
    if (row.type === MovementType.RECEIVE || row.type === MovementType.PO_RECEIVE) {
      cur.received = new Decimal(cur.received).plus(qty).toString();
    } else if (row.type === MovementType.WASTE) {
      cur.wasted = new Decimal(cur.wasted).plus(qty.abs()).toString();
    } else if (row.type === MovementType.TRANSFER_OUT) {
      cur.transferredOut = new Decimal(cur.transferredOut).plus(qty.abs()).toString();
    }
    target.set(row.ingredientId, cur);
  }
}

async function loadContext(params: { organizationId: string; branchId: string; date: string | null }) {
  const [ingredientRows, stockItems] = await Promise.all([
    prisma.ingredient.findMany({
      where: { organizationId: params.organizationId },
      select: {
        id: true,
        name: true,
        unit: true,
        defaultLowStockAt: true,
        packs: { select: { name: true, size: true } },
      },
      orderBy: { name: "asc" },
    }),
    prisma.stockItem.findMany({ where: { branchId: params.branchId } }),
  ]);

  const ingredients: IngredientRef[] = ingredientRows.map((i) => ({
    id: i.id,
    name: i.name,
    unit: i.unit,
    defaultLowStockAt: i.defaultLowStockAt === null ? null : i.defaultLowStockAt.toString(),
    packs: i.packs.map((p) => ({ name: p.name, size: Number(p.size) })),
  }));
  const stock = new Map<string, StockSnapshot>(
    stockItems.map((s) => [
      s.ingredientId,
      {
        quantity: s.quantity.toString(),
        lowStockAt: s.lowStockAt.toString(),
        parLevel: s.parLevel === null ? null : s.parLevel.toString(),
      },
    ]),
  );

  const systemDay = new Map<string, SystemDay>();
  if (params.date) {
    const { start, end } = dayRangeUtc(params.date);
    const grouped = await prisma.stockMovement.groupBy({
      by: ["ingredientId", "type"],
      where: { branchId: params.branchId, createdAt: { gte: start, lt: end }, type: { in: LOGGED_TYPES } },
      _sum: { quantity: true },
    });
    foldDay(
      systemDay,
      grouped.map((g) => ({ ingredientId: g.ingredientId, type: g.type, quantity: g._sum.quantity })),
    );
  }
  return { ingredients, stock, systemDay };
}

function sheetDateAsDbDate(date: string): Date {
  return new Date(`${date}T00:00:00Z`);
}

function assertUsable(buffer: Buffer) {
  if (buffer.length === 0) throw new StockError("The file is empty.");
  if (buffer.length > MAX_IMPORT_BYTES) {
    throw new StockError(`The file is too large (limit ${Math.round(MAX_IMPORT_BYTES / 1000)} KB).`);
  }
}

export async function previewWarehouseImport(params: {
  organizationId: string;
  branch: { id: string; name: string };
  fileName: string;
  buffer: Buffer;
  mappings: Record<string, string>;
}): Promise<ImportPreview> {
  assertUsable(params.buffer);
  const fileHash = createHash("sha256").update(params.buffer).digest("hex");
  const parsed = await parseWarehouseSheet(params.buffer);
  const date = parsed.meta.date;

  const ctx = await loadContext({ organizationId: params.organizationId, branchId: params.branch.id, date });
  const plan = buildPlan({
    parsed,
    activeBranchName: params.branch.name,
    ingredients: ctx.ingredients,
    stock: ctx.stock,
    systemDay: ctx.systemDay,
    mappings: params.mappings,
    today: todayInBusinessTz(),
  });

  const sameFile = await prisma.inventoryImport.findUnique({
    where: { branchId_fileHash: { branchId: params.branch.id, fileHash } },
    include: { importedBy: { select: { name: true } } },
  });
  if (sameFile) {
    plan.blockers.push(
      `This exact file was already imported on ${sameFile.createdAt.toISOString().slice(0, 10)}${
        sameFile.importedBy ? ` by ${sameFile.importedBy.name}` : ""
      }. Nothing to do.`,
    );
  }

  const sameDate = date
    ? await prisma.inventoryImport.findMany({
        where: { branchId: params.branch.id, sheetDate: sheetDateAsDbDate(date) },
        include: { importedBy: { select: { name: true } } },
        orderBy: { createdAt: "asc" },
      })
    : [];
  const previousImportsForDate: PreviousImport[] = sameDate.map((i) => ({
    fileName: i.fileName,
    importedBy: i.importedBy?.name ?? null,
    createdAt: i.createdAt.toISOString(),
  }));
  if (previousImportsForDate.length) {
    plan.warnings.push(
      `A count for ${date} was already imported. This import will only post the differences from what's now in the system.`,
    );
  }

  return { fileName: params.fileName, fileHash, plan, previousImportsForDate };
}

const STEP_MOVEMENT: Record<StepKind, { type: MovementType; note: (date: string, itemNote: string | null) => string }> = {
  OPENING: { type: MovementType.ADJUSTMENT, note: (d) => `Opening balance (count sheet ${d})` },
  RECEIVE: { type: MovementType.RECEIVE, note: (d) => `Received per count sheet ${d}` },
  SURPLUS: { type: MovementType.ADJUSTMENT, note: (d) => `Wastage/adjustment correction (+) per count sheet ${d}` },
  WASTE: {
    type: MovementType.WASTE,
    note: (d, n) => `Per count sheet ${d}${n ? `: ${n}` : ""}`,
  },
  RECONCILE: { type: MovementType.ADJUSTMENT, note: (d) => `Count reconciliation (count sheet ${d})` },
};

async function loggedTotalsFor(tx: Tx, branchId: string, ingredientId: string, date: string) {
  const { start, end } = dayRangeUtc(date);
  const rows = await tx.stockMovement.findMany({
    where: { branchId, ingredientId, createdAt: { gte: start, lt: end }, type: { in: LOGGED_TYPES } },
    select: { ingredientId: true, type: true, quantity: true },
  });
  const map = new Map<string, SystemDay>();
  foldDay(map, rows);
  const day = map.get(ingredientId) ?? { received: "0", wasted: "0", transferredOut: "0" };
  return { received: new Decimal(day.received), wasted: new Decimal(day.wasted) };
}

/**
 * Applies a previewed import atomically. The plan is recomputed here from
 * fresh data, and each row re-reads its balance under the stock lock, so a
 * preview that went stale (a transfer shipped while someone reviewed it)
 * can't post wrong deltas. Rows with errors are skipped, never half-applied.
 */
export async function applyWarehouseImport(params: {
  organizationId: string;
  branch: { id: string; name: string };
  userId: string;
  fileName: string;
  buffer: Buffer;
  mappings: Record<string, string>;
  confirmSameDate: boolean;
}): Promise<ImportSummary> {
  const preview = await previewWarehouseImport(params);
  const { plan } = preview;
  if (plan.blockers.length) throw new StockError(plan.blockers.join(" "));
  if (preview.previousImportsForDate.length && !params.confirmSameDate) {
    throw new StockError("A count for this date was already imported. Confirm to import again.");
  }

  const date = plan.meta.date!;
  const applicable = plan.rows.filter((r) => !r.errors.length && r.match && (r.steps.length > 0 || r.policy));
  if (!applicable.length) throw new StockError("Nothing to apply: every row is either unchanged or has an error.");

  const skipped = plan.rows.filter((r) => r.errors.length);
  const movements: Record<StepKind, number> = { OPENING: 0, RECEIVE: 0, SURPLUS: 0, WASTE: 0, RECONCILE: 0 };
  let policiesSet = 0;

  try {
    return await prisma.$transaction(
      async (tx) => {
        const record = await tx.inventoryImport.create({
          data: {
            organizationId: params.organizationId,
            branchId: params.branch.id,
            sheetDate: sheetDateAsDbDate(date),
            fileName: params.fileName.slice(0, 200),
            fileHash: preview.fileHash,
            countedBy: plan.meta.countedBy,
            rowsApplied: applicable.length,
            summary: {},
            importedById: params.userId,
          },
        });

        for (const row of applicable) {
          const ingredientId = row.match!.id;
          await lockStockItem(tx, params.branch.id, ingredientId);

          const [stockItem, logged] = await Promise.all([
            tx.stockItem.findUnique({
              where: { branchId_ingredientId: { branchId: params.branch.id, ingredientId } },
            }),
            loggedTotalsFor(tx, params.branch.id, ingredientId, date),
          ]);

          const fresh = computeRowSteps({
            hasStockItem: !!stockItem,
            currentQuantity: new Decimal(stockItem?.quantity ?? 0),
            opening: new Decimal(row.opening ?? 0),
            sheetReceived: new Decimal(row.received ?? 0),
            sheetWastage: new Decimal(row.wastage ?? 0),
            actual: row.actual === null ? null : new Decimal(row.actual),
            logged,
          });

          for (const step of fresh.steps) {
            const spec = STEP_MOVEMENT[step.kind];
            await applyMovement(
              {
                branchId: params.branch.id,
                ingredientId,
                delta: step.delta,
                type: spec.type,
                refType: "warehouse_import",
                refId: record.id,
                note: spec.note(date, row.notes),
                createdById: params.userId,
                allowNegative: step.kind !== "WASTE",
              },
              tx,
            );
            movements[step.kind]++;
          }

          if (row.policy) {
            await setStockPolicy(
              {
                organizationId: params.organizationId,
                branchId: params.branch.id,
                ingredientId,
                lowStockAt: row.policy.lowStockAt,
                parLevel: row.policy.parLevel,
              },
              tx,
            );
            policiesSet++;
          }
        }

        const summary: ImportSummary = {
          importId: record.id,
          rowsApplied: applicable.length,
          rowsSkipped: skipped.length,
          rowsUnchanged: plan.unchangedRows,
          movements,
          policiesSet,
        };
        await tx.inventoryImport.update({
          where: { id: record.id },
          data: {
            summary: {
              ...summary,
              skippedRows: skipped.slice(0, 100).map((r) => ({
                row: r.rowNumber,
                item: r.itemName,
                reason: r.errors[0] ?? "",
              })),
            },
          },
        });
        return summary;
      },
      { timeout: 120_000, maxWait: 15_000 },
    );
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      throw new StockError("This exact file was already imported.");
    }
    throw e;
  }
}

export async function listRecentImports(branchId: string, take = 8) {
  const rows = await prisma.inventoryImport.findMany({
    where: { branchId },
    include: { importedBy: { select: { name: true } } },
    orderBy: { createdAt: "desc" },
    take,
  });
  return rows.map((r) => ({
    id: r.id,
    sheetDate: r.sheetDate.toISOString().slice(0, 10),
    fileName: r.fileName,
    countedBy: r.countedBy,
    rowsApplied: r.rowsApplied,
    importedBy: r.importedBy?.name ?? null,
    createdAt: r.createdAt.toISOString(),
  }));
}
