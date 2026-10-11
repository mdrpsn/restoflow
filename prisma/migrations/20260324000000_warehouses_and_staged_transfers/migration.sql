-- CreateEnum
CREATE TYPE "BranchType" AS ENUM ('STORE', 'WAREHOUSE');

-- CreateEnum
CREATE TYPE "StockTransferStatus" AS ENUM ('DRAFT', 'IN_TRANSIT', 'RECEIVED', 'CANCELLED');

-- AlterEnum
ALTER TYPE "MovementType" ADD VALUE 'TRANSFER_CANCEL';
ALTER TYPE "MovementType" ADD VALUE 'WASTE';

-- AlterTable
ALTER TABLE "Branch" ADD COLUMN     "type" "BranchType" NOT NULL DEFAULT 'STORE';

-- AlterTable
ALTER TABLE "StockTransfer" ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "cancelledById" TEXT,
ADD COLUMN     "receivedAt" TIMESTAMP(3),
ADD COLUMN     "receivedById" TEXT,
ADD COLUMN     "shippedAt" TIMESTAMP(3),
ADD COLUMN     "shippedById" TEXT,
ADD COLUMN     "status" "StockTransferStatus" NOT NULL DEFAULT 'DRAFT';

-- CreateIndex
CREATE INDEX "StockTransfer_status_idx" ON "StockTransfer"("status");
