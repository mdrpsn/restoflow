import { headers } from "next/headers";
import QRCode from "qrcode";
import { prisma } from "@/lib/prisma";
import { requireManager } from "@/lib/session";
import { PrintButton } from "@/components/print-button";

export default async function QrMenuPage() {
  const user = await requireManager();
  const branches = await prisma.branch.findMany({
    where: { organizationId: user.organizationId, type: "STORE" },
    orderBy: { name: "asc" },
  });

  const hdrs = await headers();
  const host = hdrs.get("host") ?? "localhost:3000";
  const proto = hdrs.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const origin = `${proto}://${host}`;

  const cards = await Promise.all(
    branches.map(async (b) => {
      const url = `${origin}/order/${b.code}`;
      const qr = await QRCode.toDataURL(url, { margin: 1, width: 320 });
      return { branch: b, url, qr };
    }),
  );

  return (
    <div className="space-y-6">
      <div className="print:hidden">
        <h1 className="text-2xl font-semibold tracking-tight">QR menu</h1>
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          One QR per branch — customers scan, order, and pay at the counter. Print a card and
          put it at the register or window.
        </p>
        <PrintButton />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 print:grid-cols-2">
        {cards.map(({ branch, url, qr }) => (
          <div key={branch.id} className="panel flex flex-col items-center gap-2 p-4 text-center print:break-inside-avoid">
            <h2 className="text-lg font-semibold">{branch.name}</h2>
            {/* eslint-disable-next-line @next/next/no-img-element -- a server-generated data: URI, not an app asset */}
            <img src={qr} alt={`QR code for ${branch.name} menu`} width={220} height={220} />
            <p className="break-all text-xs" style={{ color: "var(--muted)" }}>
              {url}
            </p>
          </div>
        ))}
        {cards.length === 0 && (
          <p className="text-sm" style={{ color: "var(--muted)" }}>
            No store branches yet.
          </p>
        )}
      </div>
    </div>
  );
}
