-- CreateEnum
CREATE TYPE "QrOrderStatus" AS ENUM ('PENDING', 'CLAIMED', 'CANCELLED');

-- CreateTable
CREATE TABLE "QrOrder" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "customerName" TEXT NOT NULL,
    "status" "QrOrderStatus" NOT NULL DEFAULT 'PENDING',
    "totalCents" INTEGER NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedAt" TIMESTAMP(3),
    "claimedById" TEXT,
    "cancelledAt" TIMESTAMP(3),

    CONSTRAINT "QrOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QrOrderLine" (
    "id" TEXT NOT NULL,
    "qrOrderId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitCents" INTEGER NOT NULL,
    "totalCents" INTEGER NOT NULL,
    "modifiers" JSONB,

    CONSTRAINT "QrOrderLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "QrOrder_branchId_status_createdAt_idx" ON "QrOrder"("branchId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "QrOrderLine_qrOrderId_idx" ON "QrOrderLine"("qrOrderId");

-- AddForeignKey
ALTER TABLE "QrOrder" ADD CONSTRAINT "QrOrder_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QrOrder" ADD CONSTRAINT "QrOrder_claimedById_fkey" FOREIGN KEY ("claimedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QrOrderLine" ADD CONSTRAINT "QrOrderLine_qrOrderId_fkey" FOREIGN KEY ("qrOrderId") REFERENCES "QrOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QrOrderLine" ADD CONSTRAINT "QrOrderLine_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

