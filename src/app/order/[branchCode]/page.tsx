import { notFound } from "next/navigation";
import { QrOrderClient } from "@/components/qr-order-client";
import { activeMenuForBranch, branchForOrderCode } from "@/lib/qrOrders";

export default async function OrderPage({ params }: { params: Promise<{ branchCode: string }> }) {
  const { branchCode } = await params;
  const branch = await branchForOrderCode(branchCode);
  if (!branch) notFound();

  const products = await activeMenuForBranch(branch.id);

  return (
    <QrOrderClient
      branchCode={branch.code}
      branchName={branch.name}
      products={products.map((p) => ({
        id: p.id,
        name: p.name,
        category: p.category,
        priceCents: p.priceCents,
        imageUrl: p.imageUrl,
        modifierGroups: p.modifierGroups.map((link) => ({
          id: link.modifierGroup.id,
          name: link.modifierGroup.name,
          selectionType: link.modifierGroup.selectionType,
          required: link.modifierGroup.required,
          modifiers: link.modifierGroup.modifiers.map((m) => ({
            id: m.id,
            name: m.name,
            priceCents: m.priceCents,
          })),
        })),
      }))}
    />
  );
}
