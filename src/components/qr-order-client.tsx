"use client";

import { useMemo, useState, useTransition } from "react";
import { submitQrOrderAction } from "@/actions";
import { formatMoney } from "@/lib/money";

type ModifierOption = { id: string; name: string; priceCents: number };
type ModifierGroup = {
  id: string;
  name: string;
  selectionType: "SINGLE" | "MULTI";
  required: boolean;
  modifiers: ModifierOption[];
};
type Product = {
  id: string;
  name: string;
  category: string | null;
  priceCents: number;
  imageUrl: string | null;
  modifierGroups: ModifierGroup[];
};

const UNCATEGORIZED = "Uncategorized";

type SelectedModifier = { modifierId: string; name: string; priceCents: number; quantity: number };
type CartLine = { key: string; productId: string; quantity: number; modifiers: SelectedModifier[] };

function modifiersTotalCents(modifiers: SelectedModifier[]): number {
  return modifiers.reduce((s, m) => s + m.priceCents * m.quantity, 0);
}
function lineKey(productId: string, modifiers: SelectedModifier[]): string {
  const sig = modifiers.map((m) => `${m.modifierId}:${m.quantity}`).sort().join(",");
  return `${productId}|${sig}`;
}

function ProductAvatar({ name, imageUrl }: { name: string; imageUrl?: string | null }) {
  if (imageUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- local upload thumbnail, same as the POS
      <img src={imageUrl} alt="" className="h-16 w-16 shrink-0 rounded-xl object-cover" />
    );
  }
  const letters = name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
  return (
    <div
      className="flex h-16 w-16 shrink-0 items-center justify-center rounded-xl text-xl font-bold"
      style={{ background: "var(--accent-soft)", color: "var(--accent)" }}
      aria-hidden="true"
    >
      {letters || "?"}
    </div>
  );
}

export function QrOrderClient({ branchCode, branchName, products }: { branchCode: string; branchName: string; products: Product[] }) {
  const [cart, setCart] = useState<CartLine[]>([]);
  const [category, setCategory] = useState("All");
  const [customerName, setCustomerName] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [confirmed, setConfirmed] = useState<{ code: string; totalCents: number } | null>(null);

  const [pickerProduct, setPickerProduct] = useState<Product | null>(null);
  const [pickerSelections, setPickerSelections] = useState<Record<string, SelectedModifier>>({});
  const [pickerError, setPickerError] = useState<string | null>(null);

  const productMap = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const categories = useMemo(() => {
    const set = new Set(products.map((p) => p.category || UNCATEGORIZED));
    return Array.from(set).sort();
  }, [products]);
  const visibleProducts = useMemo(
    () => (category === "All" ? products : products.filter((p) => (p.category || UNCATEGORIZED) === category)),
    [products, category],
  );

  const lines = useMemo(
    () =>
      cart.map((line) => {
        const product = productMap.get(line.productId)!;
        const unitCents = product.priceCents + modifiersTotalCents(line.modifiers);
        return { line, product, unitCents, total: unitCents * line.quantity };
      }),
    [cart, productMap],
  );
  const totalCents = lines.reduce((s, l) => s + l.total, 0);
  const itemCount = lines.reduce((s, l) => s + l.line.quantity, 0);

  function addLine(productId: string, modifiers: SelectedModifier[]) {
    const key = lineKey(productId, modifiers);
    setCart((c) => {
      const existing = c.find((l) => l.key === key);
      if (existing) return c.map((l) => (l.key === key ? { ...l, quantity: l.quantity + 1 } : l));
      return [...c, { key, productId, quantity: 1, modifiers }];
    });
  }

  function tapProduct(product: Product) {
    if (product.modifierGroups.length === 0) {
      addLine(product.id, []);
      return;
    }
    setPickerProduct(product);
    setPickerSelections({});
    setPickerError(null);
  }

  function chooseSingle(group: ModifierGroup, modifier: ModifierOption) {
    setPickerSelections((sel) => {
      const next = { ...sel };
      for (const m of group.modifiers) delete next[m.id];
      next[modifier.id] = { modifierId: modifier.id, name: modifier.name, priceCents: modifier.priceCents, quantity: 1 };
      return next;
    });
  }
  function toggleMulti(modifier: ModifierOption) {
    setPickerSelections((sel) => {
      const next = { ...sel };
      if (next[modifier.id]) delete next[modifier.id];
      else next[modifier.id] = { modifierId: modifier.id, name: modifier.name, priceCents: modifier.priceCents, quantity: 1 };
      return next;
    });
  }
  function confirmPicker() {
    if (!pickerProduct) return;
    const selections = Object.values(pickerSelections);
    for (const group of pickerProduct.modifierGroups) {
      if (group.selectionType === "SINGLE" && group.required) {
        if (!group.modifiers.some((m) => pickerSelections[m.id])) {
          setPickerError(`Choose a "${group.name}" option`);
          return;
        }
      }
    }
    addLine(pickerProduct.id, selections);
    setPickerProduct(null);
    setPickerSelections({});
    setPickerError(null);
  }

  function dec(key: string) {
    setCart((c) => c.flatMap((l) => (l.key !== key ? [l] : l.quantity - 1 > 0 ? [{ ...l, quantity: l.quantity - 1 }] : [])));
  }
  function inc(key: string) {
    setCart((c) => c.map((l) => (l.key === key ? { ...l, quantity: l.quantity + 1 } : l)));
  }

  function submit() {
    setError(null);
    if (cart.length === 0) {
      setError("Add something to your order first");
      return;
    }
    if (!customerName.trim()) {
      setError("Enter your name so staff can call your order");
      return;
    }
    startTransition(async () => {
      const res = await submitQrOrderAction({
        branchCode,
        customerName,
        note: note || undefined,
        lines: cart.map((l) => ({
          productId: l.productId,
          quantity: l.quantity,
          modifiers: l.modifiers.map((m) => ({ modifierId: m.modifierId, quantity: m.quantity })),
        })),
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setConfirmed({ code: res.code, totalCents: res.totalCents });
      setCart([]);
    });
  }

  if (confirmed) {
    return (
      <div className="mx-auto flex min-h-[70vh] max-w-md flex-col items-center justify-center gap-4 px-4 text-center">
        <div className="panel w-full p-6">
          <p className="text-sm" style={{ color: "var(--muted)" }}>
            Order sent to {branchName}
          </p>
          <p className="mt-2 text-5xl font-bold tracking-tight" style={{ color: "var(--accent)" }}>
            {confirmed.code}
          </p>
          <p className="mt-2 text-sm" style={{ color: "var(--muted)" }}>
            Show this number at the counter and pay there — we&apos;ll call it out when it&apos;s ready.
          </p>
          <p className="mt-4 font-semibold">Total: {formatMoney(confirmed.totalCents)}</p>
        </div>
        <button type="button" className="btn-secondary" onClick={() => setConfirmed(null)}>
          Place another order
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-md pb-40">
      <div className="sticky top-0 z-10 border-b bg-white/95 px-4 py-3 backdrop-blur" style={{ borderColor: "var(--line)" }}>
        <h1 className="text-lg font-semibold tracking-tight">{branchName}</h1>
        <p className="text-xs" style={{ color: "var(--muted)" }}>
          Scan-to-order — pay at the counter when your code is called.
        </p>
        <div className="mt-2 flex gap-2 overflow-x-auto pb-1">
          <button
            type="button"
            className="btn-secondary shrink-0 !px-3 !py-1 text-xs"
            style={category === "All" ? { background: "var(--accent-fill)", color: "var(--ink)" } : undefined}
            onClick={() => setCategory("All")}
          >
            All
          </button>
          {categories.map((c) => (
            <button
              key={c}
              type="button"
              className="btn-secondary shrink-0 !px-3 !py-1 text-xs"
              style={category === c ? { background: "var(--accent-fill)", color: "var(--ink)" } : undefined}
              onClick={() => setCategory(c)}
            >
              {c}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-2 px-4 py-3">
        {visibleProducts.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => tapProduct(p)}
            className="panel flex items-center gap-3 p-3 text-left transition active:scale-[0.99]"
          >
            <ProductAvatar name={p.name} imageUrl={p.imageUrl} />
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{p.name}</p>
              <p className="text-sm" style={{ color: "var(--accent)" }}>
                {formatMoney(p.priceCents)}
              </p>
            </div>
          </button>
        ))}
        {visibleProducts.length === 0 && (
          <p className="p-6 text-center text-sm" style={{ color: "var(--muted)" }}>
            Nothing in this category right now.
          </p>
        )}
      </div>

      {pickerProduct && (
        <div className="fixed inset-0 z-30 flex items-end justify-center bg-black/40 sm:items-center">
          <div className="panel max-h-[85vh] w-full max-w-md overflow-y-auto p-4 sm:rounded-2xl">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">{pickerProduct.name}</h2>
              <button type="button" className="btn-secondary !px-2 !py-1" onClick={() => setPickerProduct(null)}>
                Close
              </button>
            </div>
            <div className="mt-3 space-y-4">
              {pickerProduct.modifierGroups.map((group) => (
                <div key={group.id}>
                  <p className="text-sm font-medium">
                    {group.name} {group.required && <span style={{ color: "var(--danger)" }}>*</span>}
                  </p>
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    {group.modifiers.map((m) => {
                      const selected = !!pickerSelections[m.id];
                      return (
                        <button
                          key={m.id}
                          type="button"
                          onClick={() => (group.selectionType === "SINGLE" ? chooseSingle(group, m) : toggleMulti(m))}
                          className="rounded-lg border px-3 py-2 text-left text-sm transition"
                          style={{
                            borderColor: selected ? "var(--accent)" : "var(--line)",
                            background: selected ? "var(--accent-soft)" : "white",
                          }}
                        >
                          <span className="block">{m.name}</span>
                          {m.priceCents > 0 && (
                            <span className="text-xs" style={{ color: "var(--muted)" }}>
                              +{formatMoney(m.priceCents)}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
            {pickerError && (
              <p className="mt-3 text-sm" style={{ color: "var(--danger)" }}>
                {pickerError}
              </p>
            )}
            <button type="button" className="btn-primary mt-4 w-full" onClick={confirmPicker}>
              Add to cart
            </button>
          </div>
        </div>
      )}

      <div className="fixed inset-x-0 bottom-0 z-20 border-t bg-white p-4" style={{ borderColor: "var(--line)" }}>
        {cart.length > 0 && (
          <div className="mb-3 max-h-40 space-y-2 overflow-y-auto">
            {lines.map(({ line, product, unitCents, total }) => (
              <div key={line.key} className="flex items-center justify-between gap-2 text-sm">
                <div className="min-w-0 flex-1">
                  <p className="truncate">{product.name}</p>
                  {line.modifiers.length > 0 && (
                    <p className="truncate text-xs" style={{ color: "var(--muted)" }}>
                      {line.modifiers.map((m) => m.name).join(", ")}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <button type="button" className="btn-secondary !h-7 !w-7 !p-0" onClick={() => dec(line.key)}>
                    −
                  </button>
                  <span className="w-4 text-center">{line.quantity}</span>
                  <button type="button" className="btn-secondary !h-7 !w-7 !p-0" onClick={() => inc(line.key)}>
                    +
                  </button>
                </div>
                <span className="w-16 text-right font-medium">{formatMoney(total)}</span>
                <span className="sr-only">Unit price {formatMoney(unitCents)}</span>
              </div>
            ))}
          </div>
        )}

        {cart.length > 0 && (
          <>
            <input
              value={customerName}
              onChange={(e) => setCustomerName(e.target.value)}
              placeholder="Your name"
              maxLength={80}
              className="mb-2 w-full rounded-lg border px-3 py-2 text-sm"
              style={{ borderColor: "var(--line)" }}
            />
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Note for the kitchen (optional)"
              maxLength={300}
              className="mb-2 w-full rounded-lg border px-3 py-2 text-sm"
              style={{ borderColor: "var(--line)" }}
            />
          </>
        )}

        {error && (
          <p className="mb-2 text-sm" style={{ color: "var(--danger)" }}>
            {error}
          </p>
        )}

        <button
          type="button"
          disabled={cart.length === 0 || pending}
          onClick={submit}
          className="btn-primary w-full justify-between !px-4 !py-3"
        >
          <span>
            {itemCount > 0 ? `${itemCount} item${itemCount > 1 ? "s" : ""}` : "Add items to order"}
          </span>
          <span>{pending ? "Sending…" : formatMoney(totalCents)}</span>
        </button>
      </div>
    </div>
  );
}
