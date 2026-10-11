"use server";

import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { z } from "zod";
import {
  BranchType,
  PaymentMethod,
  PurchaseOrderStatus,
  Role,
} from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";
import { prisma } from "@/lib/prisma";
import { requireManager, requireOwner, requireSession, requireWarehouseAdmin } from "@/lib/session";
import { requireActiveBranch } from "@/lib/branch";
import { canAccessBranch, isManagerOrAbove, type SessionUser } from "@/lib/rbac";
import { completeSale, voidSale } from "@/lib/sales";
import { setProductAvailability } from "@/lib/productAvailability";
import { applyWarehouseImport, previewWarehouseImport } from "@/lib/warehouseImport";
import { MAX_IMPORT_BYTES } from "@/lib/warehouseImportCore";
import { createUser, updateUser, type UserUpdate } from "@/lib/users";
import {
  adjustStock,
  cancelTransfer,
  createTransfer,
  logWaste,
  receiveStock,
  receiveTransfer,
  runCycleCount,
  shipTransfer,
} from "@/lib/transfers";
import { cancelPurchaseOrder, receivePurchaseOrder } from "@/lib/purchasing";
import {
  approveStockRequest,
  createStockRequest,
  rejectStockRequest,
  submitAutomatedStockRequestDraft,
} from "@/lib/stockRequests";
import { setStockPolicy, StockError } from "@/lib/stock";
import { parseMoneyToCents } from "@/lib/money";
import { setProductRecipe } from "@/lib/recipes";
import { getDailyOperationsSummary } from "@/lib/dailySummary";
import { generateDailySummaryNarrative } from "@/lib/aiSummary";
import { saveProductImage, deleteProductImage } from "@/lib/productImages";
import { branchForOrderCode, submitQrOrder, listPendingQrOrders, claimQrOrder, cancelQrOrder, releaseQrOrder } from "@/lib/qrOrders";

function fail(error: unknown): { ok: false; error: string } {
  unstable_rethrow(error);
  if (error instanceof StockError || error instanceof Error) {
    return { ok: false, error: error.message };
  }
  return { ok: false, error: "Unexpected error" };
}

export async function completeSaleAction(input: {
  lines: {
    productId: string;
    quantity: number;
    modifiers?: { modifierId: string; quantity: number }[];
  }[];
  paymentMethod: "CASH" | "CARD" | "PLATFORM";
  channel?: "WALK_IN" | "FOODPANDA" | "GRABFOOD";
  externalRef?: string;
  allowNegativeStock?: boolean;
  qrOrderId?: string;
}) {
  try {
    const user = await requireSession();
    const branch = await requireActiveBranch(user);
    if (branch.type === "WAREHOUSE") {
      throw new Error("Cannot record a sale at a warehouse branch");
    }
    const allowNegative =
      !!input.allowNegativeStock && isManagerOrAbove(user.role);

    const sale = await completeSale({
      branchId: branch.id,
      cashierId: user.id,
      organizationId: user.organizationId,
      paymentMethod: input.paymentMethod as PaymentMethod,
      channel: input.channel,
      externalRef: input.externalRef,
      lines: input.lines,
      allowNegativeStock: allowNegative,
      qrOrderId: input.qrOrderId,
    });
    revalidatePath("/pos");
    revalidatePath("/inventory");
    revalidatePath("/reports");
    return { ok: true as const, saleId: sale.id, totalCents: sale.totalCents };
  } catch (e) {
    return fail(e);
  }
}

export async function voidSaleAction(saleId: string) {
  try {
    const user = await requireManager();
    const sale = await prisma.sale.findFirst({
      where: { id: saleId, branch: { organizationId: user.organizationId } },
      select: { branchId: true },
    });
    if (!sale) throw new Error("Sale not found");
    if (!canAccessBranch(user, sale.branchId)) {
      throw new Error("You do not have access to this sale's branch");
    }
    await voidSale({
      saleId,
      organizationId: user.organizationId,
      userId: user.id,
    });
    revalidatePath("/pos");
    revalidatePath("/inventory");
    revalidatePath("/reports");
    return { ok: true as const };
  } catch (e) {
    return fail(e);
  }
}

const importMappingsSchema = z.record(z.string(), z.string());

function readImportForm(formData: FormData) {
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    throw new Error("Choose the filled-in count sheet (.xlsx) first.");
  }
  if (!file.name.toLowerCase().endsWith(".xlsx")) {
    throw new Error("Only .xlsx files are supported. Save the sheet as an Excel Workbook (.xlsx).");
  }
  if (file.size > MAX_IMPORT_BYTES) {
    throw new Error(`The file is too large (limit ${Math.round(MAX_IMPORT_BYTES / 1000)} KB).`);
  }
  const rawMappings = formData.get("mappings");
  const mappings =
    typeof rawMappings === "string" && rawMappings
      ? importMappingsSchema.parse(JSON.parse(rawMappings))
      : {};
  return { file, mappings, confirmSameDate: formData.get("confirmSameDate") === "true" };
}

export async function previewWarehouseImportAction(formData: FormData) {
  try {
    const user = await requireWarehouseAdmin();
    const branch = await requireActiveBranch(user);
    const { file, mappings } = readImportForm(formData);
    const preview = await previewWarehouseImport({
      organizationId: user.organizationId,
      branch: { id: branch.id, name: branch.name },
      fileName: file.name,
      buffer: Buffer.from(await file.arrayBuffer()),
      mappings,
    });
    return { ok: true as const, preview };
  } catch (e) {
    return fail(e);
  }
}

export async function applyWarehouseImportAction(formData: FormData) {
  try {
    const user = await requireWarehouseAdmin();
    const branch = await requireActiveBranch(user);
    const { file, mappings, confirmSameDate } = readImportForm(formData);
    const summary = await applyWarehouseImport({
      organizationId: user.organizationId,
      branch: { id: branch.id, name: branch.name },
      userId: user.id,
      fileName: file.name,
      buffer: Buffer.from(await file.arrayBuffer()),
      mappings,
      confirmSameDate,
    });
    revalidatePath("/inventory");
    revalidatePath("/inventory/import");
    revalidatePath("/reports");
    return { ok: true as const, summary };
  } catch (e) {
    return fail(e);
  }
}

export async function setProductAvailabilityAction(productId: string, available: boolean) {
  try {
    const user = await requireSession();
    const branch = await requireActiveBranch(user);
    await setProductAvailability({
      organizationId: user.organizationId,
      branchId: branch.id,
      productId,
      available,
      userId: user.id,
    });
    revalidatePath("/pos");
    return { ok: true as const };
  } catch (e) {
    return fail(e);
  }
}

const productSchema = z.object({
  name: z.string().min(1),
  sku: z.string().optional(),
  price: z.string().min(1),
  foodpandaPrice: z.string().optional(),
  grabfoodPrice: z.string().optional(),
  active: z.coerce.boolean().optional(),
  recipe: z
    .array(
      z.object({
        ingredientId: z.string().min(1),
        quantity: z.coerce.number().positive(),
      }),
    )
    .optional(),
});

export async function upsertProductAction(formData: FormData) {
  try {
    const user = await requireManager();
    const id = String(formData.get("id") || "");
    const recipeRaw = String(formData.get("recipeJson") || "[]");
    const parsed = productSchema.parse({
      name: formData.get("name"),
      sku: formData.get("sku") || undefined,
      price: formData.get("price"),
      foodpandaPrice: formData.get("foodpandaPrice") || undefined,
      grabfoodPrice: formData.get("grabfoodPrice") || undefined,
      active: formData.get("active") === "on" || formData.get("active") === "true",
      recipe: JSON.parse(recipeRaw),
    });

    const priceCents = parseMoneyToCents(parsed.price);
    if (priceCents <= 0) throw new Error("Price must be positive");
    // Blank field = "same as walk-in price", so its ProductChannelPrice row is removed
    // rather than left stale; a value overrides the base price for that platform.
    const channelPrices: { channel: "FOODPANDA" | "GRABFOOD"; priceCents: number | null }[] = [
      { channel: "FOODPANDA", priceCents: parsed.foodpandaPrice ? parseMoneyToCents(parsed.foodpandaPrice) : null },
      { channel: "GRABFOOD", priceCents: parsed.grabfoodPrice ? parseMoneyToCents(parsed.grabfoodPrice) : null },
    ];

    if (id) {
      await prisma.$transaction(async (tx) => {
        const updated = await tx.product.updateMany({
          where: { id, organizationId: user.organizationId },
          data: {
            name: parsed.name,
            sku: parsed.sku || null,
            priceCents,
            active: parsed.active ?? true,
          },
        });
        if (updated.count === 0) throw new Error("Product not found");
        for (const cp of channelPrices) {
          if (cp.priceCents === null) {
            await tx.productChannelPrice.deleteMany({ where: { productId: id, channel: cp.channel } });
          } else {
            await tx.productChannelPrice.upsert({
              where: { productId_channel: { productId: id, channel: cp.channel } },
              update: { priceCents: cp.priceCents },
              create: { productId: id, channel: cp.channel, priceCents: cp.priceCents },
            });
          }
        }
        if (parsed.recipe) {
          // The editor only shows always-on lines. Carry the sweetness-dependent
          // ones (fructose etc.) into the new version instead of silently dropping them.
          const kept = await tx.recipeLine.findMany({
            where: { productId: id, isActive: true, sweetnessPercent: { not: null } },
          });
          await setProductRecipe(tx, id, [
            ...parsed.recipe,
            ...kept.map((k) => ({
              ingredientId: k.ingredientId,
              quantity: Number(k.quantity.toString()),
              sweetnessPercent: k.sweetnessPercent,
            })),
          ]);
        }
      });
    } else {
      await prisma.product.create({
        data: {
          organizationId: user.organizationId,
          name: parsed.name,
          sku: parsed.sku || null,
          priceCents,
          active: parsed.active ?? true,
          recipeLines: parsed.recipe?.length
            ? {
                create: parsed.recipe.map((r) => ({
                  ingredientId: r.ingredientId,
                  quantity: new Decimal(r.quantity),
                })),
              }
            : undefined,
          channelPrices: {
            create: channelPrices
              .filter((cp) => cp.priceCents !== null)
              .map((cp) => ({ channel: cp.channel, priceCents: cp.priceCents! })),
          },
        },
      });
    }

    revalidatePath("/catalog/products");
    return { ok: true as const };
  } catch (e) {
    return fail(e);
  }
}

export async function upsertIngredientAction(formData: FormData) {
  try {
    const user = await requireManager();
    const id = String(formData.get("id") || "");
    const name = String(formData.get("name") || "").trim();
    const unit = String(formData.get("unit") || "").trim();
    const cost = parseMoneyToCents(String(formData.get("cost") || "0"));
    if (!name || !unit) throw new Error("Name and unit required");

    if (id) {
      const updated = await prisma.ingredient.updateMany({
        where: { id, organizationId: user.organizationId },
        data: { name, unit, costCentsPerUnit: cost },
      });
      if (updated.count === 0) throw new Error("Ingredient not found");
    } else {
      await prisma.ingredient.create({
        data: {
          organizationId: user.organizationId,
          name,
          unit,
          costCentsPerUnit: cost,
        },
      });
    }
    revalidatePath("/catalog/ingredients");
    revalidatePath("/catalog/products");
    return { ok: true as const };
  } catch (e) {
    return fail(e);
  }
}

export async function upsertIngredientPackAction(formData: FormData) {
  try {
    const user = await requireManager();
    const ingredientId = String(formData.get("ingredientId") || "");
    const name = String(formData.get("name") || "").trim();
    const size = Number(formData.get("size"));
    const makeDefault = formData.get("isDefault") === "on";
    if (!name) throw new Error("Pack name required");
    if (!Number.isFinite(size) || size <= 0) throw new Error("Pack size must be more than 0");
    const ingredient = await prisma.ingredient.findFirst({
      where: { id: ingredientId, organizationId: user.organizationId },
    });
    if (!ingredient) throw new Error("Ingredient not found");
    await prisma.$transaction(async (tx) => {
      if (makeDefault) {
        await tx.ingredientPack.updateMany({ where: { ingredientId }, data: { isDefault: false } });
      }
      await tx.ingredientPack.upsert({
        where: { ingredientId_name: { ingredientId, name } },
        create: { ingredientId, name, size, isDefault: makeDefault },
        update: { size, ...(makeDefault ? { isDefault: true } : {}) },
      });
    });
    revalidatePath("/catalog/ingredients");
    revalidatePath("/inventory");
    revalidatePath("/transfers");
    return { ok: true as const };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteIngredientPackAction(formData: FormData) {
  try {
    const user = await requireManager();
    const packId = String(formData.get("packId") || "");
    const deleted = await prisma.ingredientPack.deleteMany({
      where: { id: packId, ingredient: { organizationId: user.organizationId } },
    });
    if (deleted.count === 0) throw new Error("Pack not found");
    revalidatePath("/catalog/ingredients");
    revalidatePath("/inventory");
    revalidatePath("/transfers");
    return { ok: true as const };
  } catch (e) {
    return fail(e);
  }
}

export async function receiveStockAction(formData: FormData) {
  try {
    const user = await requireWarehouseAdmin();
    const branch = await requireActiveBranch(user);
    const ingredientId = String(formData.get("ingredientId"));
    const quantity = String(formData.get("quantity"));
    const packId = String(formData.get("packId") || "") || null;
    const note = String(formData.get("note") || "") || undefined;
    await receiveStock({
      branchId: branch.id,
      createdById: user.id,
      lines: [{ ingredientId, quantity, packId, note }],
    });
    revalidatePath("/inventory");
    return { ok: true as const };
  } catch (e) {
    return fail(e);
  }
}

export async function adjustStockAction(formData: FormData) {
  try {
    const user = await requireWarehouseAdmin();
    const branch = await requireActiveBranch(user);
    await adjustStock({
      branchId: branch.id,
      ingredientId: String(formData.get("ingredientId")),
      newQuantity: String(formData.get("quantity")),
      createdById: user.id,
      note: String(formData.get("note") || "") || undefined,
    });
    revalidatePath("/inventory");
    return { ok: true as const };
  } catch (e) {
    return fail(e);
  }
}

export async function setLowStockAction(formData: FormData) {
  try {
    const user = await requireWarehouseAdmin();
    const branch = await requireActiveBranch(user);
    const ingredientId = String(formData.get("ingredientId"));
    await setStockPolicy({
      organizationId: user.organizationId,
      branchId: branch.id,
      ingredientId,
      lowStockAt: String(formData.get("lowStockAt") || "0"),
      parLevel: String(formData.get("parLevel") || "") || null,
    });
    revalidatePath("/inventory");
    return { ok: true as const };
  } catch (e) {
    return fail(e);
  }
}

export async function submitAutomatedStockRequestDraftAction(formData: FormData) {
  try {
    const user = await requireManager();
    const requestId = String(formData.get("requestId"));
    const request = await prisma.stockRequest.findFirst({
      where: { id: requestId, organizationId: user.organizationId },
      select: { branchId: true },
    });
    if (!request) throw new Error("Draft not found");
    if (!canAccessBranch(user, request.branchId)) {
      throw new Error("You do not have access to this draft's branch");
    }
    const lines = JSON.parse(String(formData.get("linesJson") || "[]")) as {
      ingredientId: string;
      quantity: number;
    }[];
    await submitAutomatedStockRequestDraft({
      requestId,
      organizationId: user.organizationId,
      requestedById: user.id,
      lines,
    });
    revalidatePath("/requests");
    return { ok: true as const };
  } catch (e) {
    return fail(e);
  }
}

export async function runCycleCountAction(formData: FormData) {
  try {
    const user = await requireWarehouseAdmin();
    const branch = await requireActiveBranch(user);
    const counts = JSON.parse(String(formData.get("countsJson") || "[]")) as {
      ingredientId: string;
      countedQuantity: number;
    }[];
    if (!counts.length) throw new Error("No counted quantities submitted");
    const result = await runCycleCount({
      branchId: branch.id,
      createdById: user.id,
      counts,
    });
    revalidatePath("/inventory");
    revalidatePath("/inventory/cycle-count");
    return { ok: true as const, result };
  } catch (e) {
    return fail(e);
  }
}

export async function logWasteAction(formData: FormData) {
  try {
    const user = await requireWarehouseAdmin();
    const branch = await requireActiveBranch(user);
    const ingredientId = String(formData.get("ingredientId"));
    const quantity = String(formData.get("quantity"));
    const reason = String(formData.get("reason") || "").trim();
    if (!reason) throw new Error("Reason required");
    await logWaste({
      branchId: branch.id,
      ingredientId,
      quantity,
      reason,
      createdById: user.id,
    });
    revalidatePath("/inventory");
    return { ok: true as const };
  } catch (e) {
    return fail(e);
  }
}

export async function createTransferAction(formData: FormData) {
  try {
    const user = await requireWarehouseAdmin();
    const fromBranch = await requireActiveBranch(user);
    const toBranchId = String(formData.get("toBranchId"));
    const note = String(formData.get("note") || "") || undefined;
    const lines = JSON.parse(String(formData.get("linesJson") || "[]")) as {
      ingredientId: string;
      quantity: number;
      packId?: string | null;
    }[];
    if (!lines.length) throw new Error("Add at least one line");

    const dest = await prisma.branch.findFirst({
      where: { id: toBranchId, organizationId: user.organizationId },
    });
    if (!dest) throw new Error("Destination branch not found");

    await createTransfer({
      organizationId: user.organizationId,
      fromBranchId: fromBranch.id,
      toBranchId,
      createdById: user.id,
      note,
      lines,
    });
    revalidatePath("/transfers");
    return { ok: true as const };
  } catch (e) {
    return fail(e);
  }
}

async function loadTransferBranches(transferId: string, organizationId: string) {
  const transfer = await prisma.stockTransfer.findFirst({
    where: { id: transferId, fromBranch: { organizationId } },
    select: { fromBranchId: true, toBranchId: true },
  });
  if (!transfer) throw new Error("Transfer not found");
  return transfer;
}

export async function shipTransferAction(formData: FormData) {
  try {
    const user = await requireWarehouseAdmin();
    const transferId = String(formData.get("transferId"));
    const transfer = await loadTransferBranches(transferId, user.organizationId);
    if (!canAccessBranch(user, transfer.fromBranchId)) {
      throw new Error("You do not have access to the source branch for this transfer");
    }
    await shipTransfer({ transferId, organizationId: user.organizationId, userId: user.id });
    revalidatePath("/transfers");
    revalidatePath("/inventory");
    return { ok: true as const };
  } catch (e) {
    return fail(e);
  }
}

export async function receiveTransferAction(formData: FormData) {
  try {
    const user = await requireWarehouseAdmin();
    const transferId = String(formData.get("transferId"));
    const transfer = await loadTransferBranches(transferId, user.organizationId);
    if (!canAccessBranch(user, transfer.toBranchId)) {
      throw new Error("You do not have access to the destination branch for this transfer");
    }
    await receiveTransfer({ transferId, organizationId: user.organizationId, userId: user.id });
    revalidatePath("/transfers");
    revalidatePath("/inventory");
    return { ok: true as const };
  } catch (e) {
    return fail(e);
  }
}

export async function cancelTransferAction(formData: FormData) {
  try {
    const user = await requireWarehouseAdmin();
    const transferId = String(formData.get("transferId"));
    const transfer = await loadTransferBranches(transferId, user.organizationId);
    if (!canAccessBranch(user, transfer.fromBranchId) && !canAccessBranch(user, transfer.toBranchId)) {
      throw new Error("You do not have access to either branch on this transfer");
    }
    await cancelTransfer({ transferId, organizationId: user.organizationId, userId: user.id });
    revalidatePath("/transfers");
    revalidatePath("/inventory");
    return { ok: true as const };
  } catch (e) {
    return fail(e);
  }
}

export async function createStockRequestAction(formData: FormData) {
  try {
    const user = await requireSession();
    const branch = await requireActiveBranch(user);
    const note = String(formData.get("note") || "") || undefined;
    const lines = JSON.parse(String(formData.get("linesJson") || "[]")) as {
      ingredientId: string;
      quantity: number;
    }[];
    if (!lines.length) throw new Error("Add at least one line");

    await createStockRequest({
      organizationId: user.organizationId,
      branchId: branch.id,
      requestedById: user.id,
      note,
      lines,
    });
    revalidatePath("/requests");
    return { ok: true as const };
  } catch (e) {
    return fail(e);
  }
}

export async function approveStockRequestAction(formData: FormData) {
  try {
    const user = await requireWarehouseAdmin();
    const requestId = String(formData.get("requestId"));
    const approvedQuantities = JSON.parse(
      String(formData.get("approvedQuantitiesJson") || "{}"),
    ) as Record<string, number>;
    await approveStockRequest({
      requestId,
      organizationId: user.organizationId,
      reviewerId: user.id,
      approvedQuantities,
    });
    revalidatePath("/requests");
    revalidatePath("/transfers");
    return { ok: true as const };
  } catch (e) {
    return fail(e);
  }
}

export async function rejectStockRequestAction(formData: FormData) {
  try {
    const user = await requireWarehouseAdmin();
    const requestId = String(formData.get("requestId"));
    const reason = String(formData.get("reason") || "") || undefined;
    await rejectStockRequest({
      requestId,
      organizationId: user.organizationId,
      reviewerId: user.id,
      reason,
    });
    revalidatePath("/requests");
    return { ok: true as const };
  } catch (e) {
    return fail(e);
  }
}

export async function upsertSupplierAction(formData: FormData) {
  try {
    const user = await requireManager();
    const id = String(formData.get("id") || "");
    const name = String(formData.get("name") || "").trim();
    if (!name) throw new Error("Name required");
    const data = {
      name,
      contactEmail: String(formData.get("contactEmail") || "") || null,
      contactPhone: String(formData.get("contactPhone") || "") || null,
      notes: String(formData.get("notes") || "") || null,
      active: formData.get("active") !== "false",
    };
    if (id) {
      const updated = await prisma.supplier.updateMany({
        where: { id, organizationId: user.organizationId },
        data,
      });
      if (updated.count === 0) throw new Error("Supplier not found");
    } else {
      await prisma.supplier.create({
        data: { ...data, organizationId: user.organizationId },
      });
    }
    revalidatePath("/purchasing/suppliers");
    return { ok: true as const };
  } catch (e) {
    return fail(e);
  }
}

export async function createPurchaseOrderAction(formData: FormData) {
  try {
    const user = await requireManager();
    const branch = await requireActiveBranch(user);
    const supplierId = String(formData.get("supplierId"));
    const note = String(formData.get("note") || "") || undefined;
    const lines = JSON.parse(String(formData.get("linesJson") || "[]")) as {
      ingredientId: string;
      quantityOrdered: number;
      unitCostCents: number;
    }[];
    if (!lines.length) throw new Error("Add at least one line");

    await prisma.purchaseOrder.create({
      data: {
        organizationId: user.organizationId,
        branchId: branch.id,
        supplierId,
        status: PurchaseOrderStatus.ORDERED,
        orderedAt: new Date(),
        createdById: user.id,
        note,
        lines: {
          create: lines.map((l) => ({
            ingredientId: l.ingredientId,
            quantityOrdered: new Decimal(l.quantityOrdered),
            unitCostCents: l.unitCostCents,
          })),
        },
      },
    });
    revalidatePath("/purchasing/orders");
    return { ok: true as const };
  } catch (e) {
    return fail(e);
  }
}

async function requirePoBranchAccess(user: SessionUser, purchaseOrderId: string) {
  const po = await prisma.purchaseOrder.findFirst({
    where: { id: purchaseOrderId, organizationId: user.organizationId },
    select: { branchId: true },
  });
  if (!po) throw new Error("Purchase order not found");
  if (!canAccessBranch(user, po.branchId)) {
    throw new Error("You do not have access to this purchase order's branch");
  }
}

export async function receivePoAction(formData: FormData) {
  try {
    const user = await requireManager();
    const purchaseOrderId = String(formData.get("purchaseOrderId"));
    await requirePoBranchAccess(user, purchaseOrderId);
    const receipts = JSON.parse(String(formData.get("receiptsJson") || "[]")) as {
      lineId: string;
      quantity: number;
    }[];
    await receivePurchaseOrder({
      purchaseOrderId,
      organizationId: user.organizationId,
      userId: user.id,
      receipts,
    });
    revalidatePath("/purchasing/orders");
    revalidatePath("/inventory");
    return { ok: true as const };
  } catch (e) {
    return fail(e);
  }
}

export async function cancelPurchaseOrderAction(formData: FormData) {
  try {
    const user = await requireManager();
    const purchaseOrderId = String(formData.get("purchaseOrderId"));
    await requirePoBranchAccess(user, purchaseOrderId);
    await cancelPurchaseOrder({
      purchaseOrderId,
      organizationId: user.organizationId,
      userId: user.id,
    });
    revalidatePath("/purchasing/orders");
    return { ok: true as const };
  } catch (e) {
    return fail(e);
  }
}

export async function createBranchAction(formData: FormData) {
  try {
    const user = await requireOwner();
    const name = String(formData.get("name") || "").trim();
    const code = String(formData.get("code") || "").trim().toUpperCase();
    const type = formData.get("type") === "WAREHOUSE" ? BranchType.WAREHOUSE : BranchType.STORE;
    if (!name || !code) throw new Error("Name and code required");
    await prisma.branch.create({
      data: { organizationId: user.organizationId, name, code, type },
    });
    revalidatePath("/admin/branches");
    return { ok: true as const };
  } catch (e) {
    return fail(e);
  }
}

export async function updateUserAction(input: UserUpdate) {
  try {
    const user = await requireOwner();
    await updateUser(user.organizationId, user.id, input);
    revalidatePath("/admin/users");
    return { ok: true as const };
  } catch (error) {
    return fail(error);
  }
}

export async function createUserAction(formData: FormData) {
  try {
    const user = await requireOwner();
    const role = String(formData.get("role") || "CASHIER") as Role;
    const email = String(formData.get("email") || "").trim();

    const created = await createUser({
      organizationId: user.organizationId,
      firstName: String(formData.get("firstName") || ""),
      lastName: String(formData.get("lastName") || ""),
      email: email || undefined,
      password: String(formData.get("password") || ""),
      role,
      branchIds: formData.getAll("branchIds").map(String),
    });
    revalidatePath("/admin/users");
    return { ok: true as const, username: created.username };
  } catch (e) {
    return fail(e);
  }
}

/**
 * Generated on demand (not on every page load) so a report a manager checks
 * repeatedly doesn't quietly burn API calls. The narrative is read-only prose
 * over numbers computed elsewhere; nothing here can mutate any data.
 */
export async function generateDailySummaryNarrativeAction(branchCode: string, date: string) {
  try {
    const user = await requireManager();
    const branch = await prisma.branch.findFirst({
      where: { organizationId: user.organizationId, code: branchCode },
    });
    if (!branch) throw new Error("Branch not found");
    if (!canAccessBranch(user, branch.id)) throw new Error("You do not have access to this branch");

    const summary = await getDailyOperationsSummary({
      organizationId: user.organizationId,
      branchCode,
      date,
    });
    const narrative = await generateDailySummaryNarrative(summary);
    return { ok: true as const, narrative };
  } catch (e) {
    return fail(e);
  }
}

export async function uploadProductImageAction(formData: FormData) {
  try {
    const user = await requireManager();
    const productId = String(formData.get("productId") || "");
    const file = formData.get("file");
    if (!(file instanceof File)) throw new Error("No file provided");

    const product = await prisma.product.findFirst({
      where: { id: productId, organizationId: user.organizationId },
      select: { id: true },
    });
    if (!product) throw new Error("Product not found");

    const imageUrl = await saveProductImage(productId, file);
    await prisma.product.update({ where: { id: productId }, data: { imageUrl } });
    revalidatePath("/catalog/products");
    revalidatePath("/pos");
    return { ok: true as const, imageUrl };
  } catch (e) {
    return fail(e);
  }
}

export async function removeProductImageAction(productId: string) {
  try {
    const user = await requireManager();
    const product = await prisma.product.findFirst({
      where: { id: productId, organizationId: user.organizationId },
      select: { id: true },
    });
    if (!product) throw new Error("Product not found");

    await deleteProductImage(productId);
    await prisma.product.update({ where: { id: productId }, data: { imageUrl: null } });
    revalidatePath("/catalog/products");
    revalidatePath("/pos");
    return { ok: true as const };
  } catch (e) {
    return fail(e);
  }
}

// --- QR self-order. submitQrOrderAction is the only one of these callable without a
// session — it's used from the public /order/[branchCode] page. Everything else is the
// cashier-side pending queue, gated the same as the rest of the POS.

export async function submitQrOrderAction(input: {
  branchCode: string;
  customerName: string;
  note?: string;
  lines: {
    productId: string;
    quantity: number;
    modifiers?: { modifierId: string; quantity: number }[];
  }[];
}) {
  try {
    const branch = await branchForOrderCode(input.branchCode.trim());
    if (!branch) throw new Error("This QR code isn't linked to a store yet");
    const result = await submitQrOrder({
      branchId: branch.id,
      customerName: input.customerName,
      note: input.note,
      lines: input.lines,
    });
    return { ok: true as const, ...result };
  } catch (e) {
    return fail(e);
  }
}

export async function listPendingQrOrdersAction() {
  try {
    const user = await requireSession();
    const branch = await requireActiveBranch(user);
    const orders = await listPendingQrOrders(branch.id);
    return { ok: true as const, orders };
  } catch (e) {
    return fail(e);
  }
}

export async function claimQrOrderAction(qrOrderId: string) {
  try {
    const user = await requireSession();
    const branch = await requireActiveBranch(user);
    const claimed = await claimQrOrder(qrOrderId, user.id, branch.id);
    revalidatePath("/pos");
    return {
      ok: true as const,
      id: claimed.id,
      note: claimed.note,
      code: claimed.code,
      customerName: claimed.customerName,
      cartLines: claimed.cartLines,
    };
  } catch (e) {
    return fail(e);
  }
}

export async function cancelQrOrderAction(qrOrderId: string) {
  try {
    const user = await requireSession();
    const branch = await requireActiveBranch(user);
    await cancelQrOrder(qrOrderId, branch.id);
    revalidatePath("/pos");
    return { ok: true as const };
  } catch (e) {
    return fail(e);
  }
}

export async function releaseQrOrderAction(qrOrderId: string) {
  try {
    const user = await requireSession();
    const branch = await requireActiveBranch(user);
    await releaseQrOrder(qrOrderId, user.id, branch.id, isManagerOrAbove(user.role));
    revalidatePath("/pos");
    return { ok: true as const };
  } catch (error) {
    return fail(error);
  }
}
