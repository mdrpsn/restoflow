import {
  IntegrationEventSeverity,
  IntegrationEventType,
  Prisma,
  type PrismaClient,
} from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";
import { prisma } from "@/lib/prisma";

export type DbClient = Prisma.TransactionClient | PrismaClient;
export type StockState = "NORMAL" | "LOW" | "CRITICAL";

export function classifyStock(
  quantity: Decimal | number | string,
  lowStockAt: Decimal | number | string,
): StockState {
  const qty = new Decimal(quantity);
  if (qty.lessThanOrEqualTo(0)) return "CRITICAL";
  if (qty.lessThanOrEqualTo(new Decimal(lowStockAt))) return "LOW";
  return "NORMAL";
}

export async function queueIntegrationEvent(
  client: DbClient,
  input: {
    organizationId: string;
    branchId?: string;
    type: IntegrationEventType;
    severity: IntegrationEventSeverity;
    dedupeKey: string;
    payload: Prisma.InputJsonValue;
  },
) {
  return client.integrationEvent.upsert({
    where: { dedupeKey: input.dedupeKey },
    update: {},
    create: input,
  });
}

export async function queueStockTransition(
  client: DbClient,
  input: {
    organizationId: string;
    branchId: string;
    branchCode: string;
    branchName: string;
    ingredientId: string;
    ingredientName: string;
    unit: string;
    previousState: StockState;
    nextState: StockState;
    quantity: Decimal | number | string;
    lowStockAt: Decimal | number | string;
    parLevel?: Decimal | number | string | null;
    causeKey: string;
  },
) {
  if (input.previousState === input.nextState) return null;

  const type =
    input.nextState === "CRITICAL"
      ? IntegrationEventType.INVENTORY_CRITICAL
      : input.nextState === "LOW"
        ? IntegrationEventType.INVENTORY_LOW
        : IntegrationEventType.INVENTORY_RECOVERED;
  const severity =
    input.nextState === "CRITICAL"
      ? IntegrationEventSeverity.CRITICAL
      : input.nextState === "LOW"
        ? IntegrationEventSeverity.WARNING
        : IntegrationEventSeverity.INFO;

  return queueIntegrationEvent(client, {
    organizationId: input.organizationId,
    branchId: input.branchId,
    type,
    severity,
    dedupeKey: `stock:${input.causeKey}:${type}`,
    payload: {
      branchCode: input.branchCode,
      branchName: input.branchName,
      ingredientId: input.ingredientId,
      ingredientName: input.ingredientName,
      unit: input.unit,
      previousState: input.previousState,
      state: input.nextState,
      quantity: new Decimal(input.quantity).toString(),
      lowStockAt: new Decimal(input.lowStockAt).toString(),
      parLevel: input.parLevel === null || input.parLevel === undefined
        ? null
        : new Decimal(input.parLevel).toString(),
      inventoryPath: "/inventory",
    },
  });
}

export async function getPendingIntegrationEvents(params: {
  organizationId: string;
  branchCode?: string;
  limit?: number;
}) {
  const limit = Math.max(1, Math.min(params.limit ?? 50, 100));
  const events = await prisma.integrationEvent.findMany({
    where: {
      organizationId: params.organizationId,
      acknowledgedAt: null,
      branch: params.branchCode ? { code: params.branchCode } : undefined,
    },
    include: { branch: { select: { code: true, name: true } } },
    orderBy: { createdAt: "asc" },
    take: limit,
  });

  if (events.length) {
    await prisma.integrationEvent.updateMany({
      where: { id: { in: events.map((event) => event.id) }, organizationId: params.organizationId },
      data: { deliveryAttempts: { increment: 1 }, lastDeliveredAt: new Date() },
    });
  }

  return events.map((event) => ({
    id: event.id,
    type: event.type,
    severity: event.severity,
    branch: event.branch,
    payload: event.payload,
    deliveryAttempts: event.deliveryAttempts + 1,
    createdAt: event.createdAt.toISOString(),
  }));
}

export async function acknowledgeIntegrationEvent(params: {
  organizationId: string;
  eventId: string;
}) {
  const event = await prisma.integrationEvent.findFirst({
    where: { id: params.eventId, organizationId: params.organizationId },
  });
  if (!event) return null;
  if (event.acknowledgedAt) return event;
  return prisma.integrationEvent.update({
    where: { id: event.id },
    data: { acknowledgedAt: new Date() },
  });
}

export async function getIntegrationHealth(organizationId: string, branchCode?: string) {
  const staleBefore = new Date(Date.now() - 5 * 60_000);
  const scope = {
    organizationId,
    acknowledgedAt: null,
    branch: branchCode ? { code: branchCode } : undefined,
  } as const;
  const [pendingCount, staleCount, oldest] = await Promise.all([
    prisma.integrationEvent.count({ where: scope }),
    prisma.integrationEvent.count({
      where: { ...scope, createdAt: { lt: staleBefore } },
    }),
    prisma.integrationEvent.findFirst({
      where: scope,
      orderBy: { createdAt: "asc" },
      select: { createdAt: true, deliveryAttempts: true },
    }),
  ]);
  return {
    ok: staleCount === 0,
    pendingCount,
    staleCount,
    oldestPendingAt: oldest?.createdAt.toISOString() ?? null,
    oldestDeliveryAttempts: oldest?.deliveryAttempts ?? 0,
    checkedAt: new Date().toISOString(),
  };
}
