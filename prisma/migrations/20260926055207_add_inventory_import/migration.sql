-- CreateTable
CREATE TABLE "InventoryImport" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "sheetDate" DATE NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileHash" TEXT NOT NULL,
    "countedBy" TEXT,
    "rowsApplied" INTEGER NOT NULL,
    "summary" JSONB NOT NULL,
    "importedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InventoryImport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InventoryImport_branchId_sheetDate_idx" ON "InventoryImport"("branchId", "sheetDate");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryImport_branchId_fileHash_key" ON "InventoryImport"("branchId", "fileHash");

-- AddForeignKey
ALTER TABLE "InventoryImport" ADD CONSTRAINT "InventoryImport_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryImport" ADD CONSTRAINT "InventoryImport_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryImport" ADD CONSTRAINT "InventoryImport_importedById_fkey" FOREIGN KEY ("importedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
