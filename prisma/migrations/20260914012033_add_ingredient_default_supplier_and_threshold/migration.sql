-- AlterTable
ALTER TABLE "Ingredient" ADD COLUMN     "defaultLowStockAt" DECIMAL(14,4),
ADD COLUMN     "defaultSupplierId" TEXT;

-- CreateIndex
CREATE INDEX "Ingredient_defaultSupplierId_idx" ON "Ingredient"("defaultSupplierId");

-- AddForeignKey
ALTER TABLE "Ingredient" ADD CONSTRAINT "Ingredient_defaultSupplierId_fkey" FOREIGN KEY ("defaultSupplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;
