-- DropIndex
DROP INDEX "RecipeLine_productId_ingredientId_version_key";

-- AlterTable
ALTER TABLE "Modifier" ADD COLUMN     "sweetnessPercent" INTEGER;

-- AlterTable
ALTER TABLE "RecipeLine" ADD COLUMN     "sweetnessPercent" INTEGER;

-- AlterTable
ALTER TABLE "SaleLine" ADD COLUMN     "sweetnessPercent" INTEGER;

-- CreateIndex
CREATE UNIQUE INDEX "RecipeLine_productId_ingredientId_version_sweetnessPercent_key" ON "RecipeLine"("productId", "ingredientId", "version", "sweetnessPercent");

