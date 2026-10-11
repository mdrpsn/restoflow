-- DropIndex
DROP INDEX "RecipeLine_productId_ingredientId_key";

-- AlterTable
ALTER TABLE "RecipeLine" ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "SaleLine" ADD COLUMN     "recipeVersion" INTEGER;

-- CreateIndex
CREATE INDEX "RecipeLine_productId_isActive_idx" ON "RecipeLine"("productId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "RecipeLine_productId_ingredientId_version_key" ON "RecipeLine"("productId", "ingredientId", "version");
