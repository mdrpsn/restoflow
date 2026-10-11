-- Main-branch inventory automation pilot.
ALTER TYPE "StockRequestStatus" ADD VALUE 'DRAFT' BEFORE 'PENDING';

CREATE TYPE "StockRequestSource" AS ENUM ('MANUAL', 'AUTOMATION');
CREATE TYPE "IntegrationEventType" AS ENUM (
  'INVENTORY_LOW',
  'INVENTORY_CRITICAL',
  'INVENTORY_RECOVERED',
  'NEGATIVE_STOCK_OVERRIDE',
  'MISSING_RECIPE',
  'WASTE_LOGGED'
);
CREATE TYPE "IntegrationEventSeverity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');

ALTER TABLE "StockItem"
  ADD COLUMN "parLevel" DECIMAL(14,4);

ALTER TABLE "StockRequest"
  ADD COLUMN "source" "StockRequestSource" NOT NULL DEFAULT 'MANUAL',
  ADD COLUMN "automationKey" TEXT,
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ALTER COLUMN "requestedById" DROP NOT NULL;

CREATE UNIQUE INDEX "StockRequest_automationKey_key" ON "StockRequest"("automationKey");
CREATE INDEX "StockRequest_branchId_source_status_idx" ON "StockRequest"("branchId", "source", "status");

CREATE TABLE "IntegrationEvent" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "branchId" TEXT,
  "type" "IntegrationEventType" NOT NULL,
  "severity" "IntegrationEventSeverity" NOT NULL,
  "payload" JSONB NOT NULL,
  "dedupeKey" TEXT NOT NULL,
  "deliveryAttempts" INTEGER NOT NULL DEFAULT 0,
  "lastDeliveredAt" TIMESTAMP(3),
  "acknowledgedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "IntegrationEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "IntegrationEvent_dedupeKey_key" ON "IntegrationEvent"("dedupeKey");
CREATE INDEX "IntegrationEvent_organizationId_acknowledgedAt_createdAt_idx"
  ON "IntegrationEvent"("organizationId", "acknowledgedAt", "createdAt");
CREATE INDEX "IntegrationEvent_branchId_createdAt_idx" ON "IntegrationEvent"("branchId", "createdAt");

CREATE TABLE "IntegrationMutation" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "operation" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "response" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "IntegrationMutation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "IntegrationMutation_organizationId_operation_idempotencyKey_key"
  ON "IntegrationMutation"("organizationId", "operation", "idempotencyKey");
CREATE INDEX "IntegrationMutation_organizationId_createdAt_idx"
  ON "IntegrationMutation"("organizationId", "createdAt");

ALTER TABLE "IntegrationEvent"
  ADD CONSTRAINT "IntegrationEvent_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "IntegrationEvent_branchId_fkey"
  FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "IntegrationMutation"
  ADD CONSTRAINT "IntegrationMutation_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
