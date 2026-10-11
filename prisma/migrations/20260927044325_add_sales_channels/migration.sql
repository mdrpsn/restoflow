-- CreateEnum
CREATE TYPE "SalesChannel" AS ENUM ('WALK_IN', 'FOODPANDA', 'GRABFOOD');

-- AlterEnum
ALTER TYPE "PaymentMethod" ADD VALUE 'PLATFORM';

-- AlterTable
ALTER TABLE "Sale" ADD COLUMN     "channel" "SalesChannel" NOT NULL DEFAULT 'WALK_IN',
ADD COLUMN     "externalRef" TEXT;

-- CreateTable
CREATE TABLE "ProductChannelPrice" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "channel" "SalesChannel" NOT NULL,
    "priceCents" INTEGER NOT NULL,

    CONSTRAINT "ProductChannelPrice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProductChannelPrice_productId_channel_key" ON "ProductChannelPrice"("productId", "channel");

-- CreateIndex
CREATE INDEX "Sale_branchId_channel_createdAt_idx" ON "Sale"("branchId", "channel", "createdAt");

-- AddForeignKey
ALTER TABLE "ProductChannelPrice" ADD CONSTRAINT "ProductChannelPrice_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

