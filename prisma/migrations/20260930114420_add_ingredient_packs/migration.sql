-- AlterTable
ALTER TABLE "StockTransferLine" ADD COLUMN     "packLabel" TEXT,
ADD COLUMN     "packQuantity" DECIMAL(14,4);

-- CreateTable
CREATE TABLE "IngredientPack" (
    "id" TEXT NOT NULL,
    "ingredientId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "size" DECIMAL(14,4) NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IngredientPack_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "IngredientPack_ingredientId_name_key" ON "IngredientPack"("ingredientId", "name");

-- AddForeignKey
ALTER TABLE "IngredientPack" ADD CONSTRAINT "IngredientPack_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "Ingredient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

