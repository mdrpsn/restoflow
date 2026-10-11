"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import {
  completeSaleAction,
  setProductAvailabilityAction,
  voidSaleAction,
  listPendingQrOrdersAction,
  claimQrOrderAction,
  cancelQrOrderAction,
  releaseQrOrderAction,
} from "@/actions";
import { formatMoney } from "@/lib/money";
import { confirmed } from "@/lib/confirm";
import { Badge } from "@/components/badge";

type ModifierOption = {
  id: string;
  name: string;
  priceCents: number;
};

type ModifierGroup = {
  id: string;
  name: string;
  selectionType: "SINGLE" | "MULTI";
  required: boolean;
  modifiers: ModifierOption[];
};

type Channel = "WALK_IN" | "FOODPANDA" | "GRABFOOD";

type Product = {
  id: string;
  name: string;
  category: string | null;
  priceCents: number;
  imageUrl: string | null;
  channelPrices: { channel: Channel; priceCents: number }[];
  sku: string | null;
  available: boolean;
  modifierGroups: ModifierGroup[];
};

const UNCATEGORIZED = "Uncategorized";
const VIEW_STORAGE_KEY = "restoflow.pos.menuView";
const CHANNEL_LABELS: Record<Channel, string> = {
  WALK_IN: "Walk-in / Takeout",
  FOODPANDA: "FoodPanda",
  GRABFOOD: "GrabFood",
};

function priceFor(product: Product, channel: Channel): number {
  if (channel === "WALK_IN") return product.priceCents;
  return product.channelPrices.find((cp) => cp.channel === channel)?.priceCents ?? product.priceCents;
}

type RecentSale = {
  id: string;
  totalCents: number;
  paymentMethod: string;
  channel: Channel;
  externalRef: string | null;
  createdAt: string;
  status: string;
  cashierName: string;
};

type PendingQrOrder = {
  id: string;
  status: string;
  claimedById: string | null;
  claimedByName: string | null;
  code: string;
  customerName: string;
  totalCents: number;
  note: string | null;
  createdAt: string;
  lines: { productId: string; productName: string; quantity: number; unitCents: number; modifiers: { modifierId: string; quantity: number }[] }[];
};

const QR_POLL_MS = 12_000;

type SelectedModifier = { modifierId: string; name: string; priceCents: number; quantity: number };

type CartLine = {
  key: string;
  productId: string;
  quantity: number;
  modifiers: SelectedModifier[];
};

function modifiersTotalCents(modifiers: SelectedModifier[]): number {
  return modifiers.reduce((s, m) => s + m.priceCents * m.quantity, 0);
}

function lineKey(productId: string, modifiers: SelectedModifier[]): string {
  const sig = modifiers
    .map((m) => `${m.modifierId}:${m.quantity}`)
    .sort()
    .join(",");
  return `${productId}|${sig}`;
}

function AvailabilitySwitch({
  available,
  label,
  onToggle,
}: {
  available: boolean;
  label: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={available}
      aria-label={`${label}: ${available ? "available" : "unavailable"}`}
      title={available ? "Mark unavailable" : "Mark available"}
      onClick={onToggle}
      className="relative h-6 w-11 shrink-0 rounded-full border transition"
      style={{
        background: available ? "var(--accent-fill)" : "var(--line)",
        borderColor: available ? "var(--accent-fill)" : "var(--line)",
      }}
    >
      <span
        className="absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all"
        style={{ left: available ? "calc(100% - 1.15rem)" : "0.15rem" }}
      />
    </button>
  );
}

function ProductAvatar({ name, imageUrl, size = 40 }: { name: string; imageUrl?: string | null; size?: number }) {
  if (imageUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- local upload, not worth next/image config for a 40px thumbnail
      <img
        src={imageUrl}
        alt=""
        width={size}
        height={size}
        className="shrink-0 rounded-xl object-cover"
        style={{ width: size, height: size }}
      />
    );
  }
  const letters = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-xl font-bold"
      style={{
        width: size,
        height: size,
        background: "var(--accent-soft)",
        color: "var(--accent)",
        fontSize: size * 0.36,
      }}
      aria-hidden="true"
    >
      {letters || "?"}
    </div>
  );
}

export function PosClient({
  currentUserId,
  products,
  canOverrideStock,
  canVoid,
  recentSales,
}: {
  currentUserId: string;
  products: Product[];
  canOverrideStock: boolean;
  canVoid: boolean;
  recentSales: RecentSale[];
}) {
  const [cart, setCart] = useState<CartLine[]>([]);
  const [category, setCategory] = useState<string>("All");
  const [search, setSearch] = useState("");
  const [displayCount, setDisplayCount] = useState(36);
  const [channel, setChannel] = useState<Channel>("WALK_IN");
  const [externalRef, setExternalRef] = useState("");
  const [paymentMethod, setPaymentMethod] = useState<"CASH" | "CARD">("CASH");
  const [allowNegative, setAllowNegative] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [, startAvailability] = useTransition();

  const [view, setView] = useState<"grid" | "list">("grid");
  const [availabilityOverride, setAvailabilityOverride] = useState<Record<string, boolean>>({});

  // Read the saved layout after mount (not in the initial state) so server and
  // client render the same first frame.
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(VIEW_STORAGE_KEY);
      if (saved === "grid" || saved === "list") setView(saved);
    } catch {
      // storage blocked: stay on the default layout
    }
  }, []);

  // Fresh server data supersedes any optimistic flips.
  useEffect(() => {
    setAvailabilityOverride({});
  }, [products]);

  const [pendingQrOrders, setPendingQrOrders] = useState<PendingQrOrder[]>([]);
  const [activeQrOrder, setActiveQrOrder] = useState<{ id: string; code: string; customerName: string; note: string | null } | null>(null);
  const [qrQueueError, setQrQueueError] = useState<string | null>(null);
  const [claimingQrOrderId, setClaimingQrOrderId] = useState<string | null>(null);
  const queuedQrOrders = pendingQrOrders.filter(order => order.id !== activeQrOrder?.id);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      const res = await listPendingQrOrdersAction();
      if (!cancelled) {
        if (res.ok) { setPendingQrOrders(res.orders); setQrQueueError(null); }
        else setQrQueueError("QR orders could not refresh. Check your connection and sign-in.");
      }
    }
    poll();
    const id = setInterval(poll, QR_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  function chooseView(next: "grid" | "list") {
    setView(next);
    try {
      window.localStorage.setItem(VIEW_STORAGE_KEY, next);
    } catch {
      // not persisted, still applies for this session
    }
  }

  function isAvailable(p: Product) {
    return availabilityOverride[p.id] ?? p.available;
  }

  function toggleAvailability(p: Product) {
    const next = !isAvailable(p);
    setAvailabilityOverride((o) => ({ ...o, [p.id]: next }));
    startAvailability(async () => {
      const res = await setProductAvailabilityAction(p.id, next);
      if (!res.ok) {
        setAvailabilityOverride((o) => {
          const copy = { ...o };
          delete copy[p.id];
          return copy;
        });
        setError(res.error);
      }
    });
  }

  const [pickerProduct, setPickerProduct] = useState<Product | null>(null);
  const [pickerSelections, setPickerSelections] = useState<Record<string, SelectedModifier>>({});
  const [pickerError, setPickerError] = useState<string | null>(null);

  const productMap = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);

  const categories = useMemo(() => {
    const set = new Set(products.map((p) => p.category || UNCATEGORIZED));
    return Array.from(set).sort();
  }, [products]);

  const visibleProducts = useMemo(() => {
    const byCategory = category === "All" ? products : products.filter((p) => (p.category || UNCATEGORIZED) === category);
    const q = search.trim().toLowerCase();
    if (!q) return byCategory;
    return byCategory.filter((p) => p.name.toLowerCase().includes(q) || (p.sku ?? "").toLowerCase().includes(q));
  }, [products, category, search]);

  const lines = useMemo(
    () =>
      cart.map((line) => {
        const product = productMap.get(line.productId)!;
        const unitCents = priceFor(product, channel) + modifiersTotalCents(line.modifiers);
        return { line, product, unitCents, total: unitCents * line.quantity };
      }),
    [cart, productMap, channel],
  );

  const totalCents = lines.reduce((s, l) => s + l.total, 0);

  function addLine(productId: string, modifiers: SelectedModifier[]) {
    const key = lineKey(productId, modifiers);
    setCart((c) => {
      const existing = c.find((l) => l.key === key);
      if (existing) {
        return c.map((l) => (l.key === key ? { ...l, quantity: l.quantity + 1 } : l));
      }
      return [...c, { key, productId, quantity: 1, modifiers }];
    });
  }

  function tapProduct(product: Product) {
    if (pending) return;
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

  function changeMultiQty(modifier: ModifierOption, quantity: number) {
    setPickerSelections((sel) => {
      if (quantity <= 0) {
        const next = { ...sel };
        delete next[modifier.id];
        return next;
      }
      return { ...sel, [modifier.id]: { modifierId: modifier.id, name: modifier.name, priceCents: modifier.priceCents, quantity } };
    });
  }

  function confirmPicker() {
    if (!pickerProduct) return;
    const selections = Object.values(pickerSelections);
    for (const group of pickerProduct.modifierGroups) {
      if (group.selectionType === "SINGLE" && group.required) {
        const hasChoice = group.modifiers.some((m) => pickerSelections[m.id]);
        if (!hasChoice) {
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
    if (pending) return;
    setCart((c) => {
      const next: CartLine[] = [];
      for (const l of c) {
        if (l.key !== key) {
          next.push(l);
          continue;
        }
        if (l.quantity - 1 > 0) next.push({ ...l, quantity: l.quantity - 1 });
      }
      return next;
    });
  }

  function inc(key: string) {
    if (pending) return;
    setCart((c) => c.map((l) => (l.key === key ? { ...l, quantity: l.quantity + 1 } : l)));
  }

  function checkout() {
    setMessage(null);
    setError(null);
    startTransition(async () => {
      const res = await completeSaleAction({
        paymentMethod: channel === "WALK_IN" ? paymentMethod : "PLATFORM",
        channel,
        externalRef: channel === "WALK_IN" ? undefined : externalRef,
        allowNegativeStock: allowNegative,
        qrOrderId: activeQrOrder?.id,
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
      setCart([]);
      setPendingQrOrders(list => list.filter(order => order.id !== activeQrOrder?.id));
      setActiveQrOrder(null);
      setExternalRef("");
      setChannel("WALK_IN");
      setMessage(`Sale complete — ${formatMoney(res.totalCents)}`);
    });
  }

  function voidSale(id: string) {
    if (!confirmed("Void this sale? Stock will be restored.")) return;
    startTransition(async () => {
      const res = await voidSaleAction(id);
      if (!res.ok) setError(res.error);
      else setMessage("Sale voided; stock restored");
    });
  }

  function claimQrOrder(order: PendingQrOrder) {
    if (activeQrOrder) { setError("Return the current QR order to the queue before loading another."); return; }
    if (order.lines.some(line => !productMap.has(line.productId))) { setError("The menu has changed. Refresh the page before loading this order."); return; }
    if (cart.length && !confirmed("Replace the current cart with this QR order?")) return;
    setMessage(null);
    setError(null);
    setClaimingQrOrderId(order.id);
    startTransition(async () => {
      const res = await claimQrOrderAction(order.id);
      setClaimingQrOrderId(null);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setPendingQrOrders((list) => list.filter((o) => o.id !== order.id));
      setChannel("WALK_IN");
      setExternalRef("");
      setActiveQrOrder({ id: res.id, code: res.code, customerName: res.customerName, note: res.note });
      const newLines: CartLine[] = res.cartLines.map((l) => {
        const product = productMap.get(l.productId);
        const modifiers: SelectedModifier[] = (l.modifiers ?? []).map((sel) => {
          const found = product?.modifierGroups.flatMap((g) => g.modifiers).find((m) => m.id === sel.modifierId);
          return { modifierId: sel.modifierId, name: found?.name ?? "Add-on", priceCents: found?.priceCents ?? 0, quantity: sel.quantity };
        });
        return { key: lineKey(l.productId, modifiers), productId: l.productId, quantity: l.quantity, modifiers };
      });
      setCart(newLines);
      setMessage(`Loaded ${res.code} (${res.customerName}) into the cart — confirm and take payment below`);
    });
  }

  function cancelQrOrder(id: string) {
    if (!confirmed("Cancel this QR order? The customer will need to reorder.")) return;
    startTransition(async () => {
      const res = await cancelQrOrderAction(id);
      if (!res.ok) setError(res.error);
      else setPendingQrOrders((list) => list.filter((o) => o.id !== id));
    });
  }

  function returnQrOrder(id: string) {
    if (!confirmed("Return this order to the queue? It will keep the customer's original items. Cart edits will be discarded.")) return;
    startTransition(async () => {
      const result = await releaseQrOrderAction(id);
      if (!result.ok) { setError(result.error); return; }
      if (activeQrOrder?.id === id) { setActiveQrOrder(null); setCart([]); }
      const queue = await listPendingQrOrdersAction();
      if (queue.ok) setPendingQrOrders(queue.orders);
      setMessage("Order returned to the queue");
    });
  }

  return (
    <div className="pos-layout">
      <section className="panel pos-menu min-w-0 p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div><h2 className="text-lg font-semibold">Menu</h2><p className="text-xs" style={{ color: "var(--muted)" }}>Tap an item to add it to the sale</p></div>
          <div role="group" aria-label="Menu layout" className="flex gap-1">
            {(["grid", "list"] as const).map((v) => (
              <button
                key={v}
                type="button"
                aria-pressed={view === v}
                onClick={() => chooseView(v)}
                className="btn-secondary px-2 py-1 text-xs capitalize"
                style={view === v ? { background: "var(--accent-soft)", borderColor: "var(--accent)" } : undefined}
              >
                {v}
              </button>
            ))}
          </div>
        </div>

        <input
          type="search"
          className="field mb-3"
          placeholder="Search menu…"
          value={search}
          onChange={(e) => { setSearch(e.target.value); setDisplayCount(36); }}
          aria-label="Search menu"
        />

        <div className="mb-4 flex gap-2 overflow-x-auto pb-1" role="tablist" aria-label="Category">
          <button
            type="button"
            role="tab"
            aria-selected={category === "All"}
            onClick={() => { setCategory("All"); setDisplayCount(36); }}
            className="shrink-0 whitespace-nowrap rounded-full px-4 py-2 text-sm font-medium transition"
            style={
              category === "All"
                ? { background: "var(--accent-fill)", color: "var(--ink)" }
                : { background: "var(--accent-soft)", color: "var(--accent)" }
            }
          >
            All <span style={{ opacity: 0.75 }}>({products.length})</span>
          </button>
          {categories.map((c) => (
            <button
              key={c}
              type="button"
              role="tab"
              aria-selected={category === c}
              onClick={() => { setCategory(c); setDisplayCount(36); }}
              className="shrink-0 whitespace-nowrap rounded-full px-4 py-2 text-sm font-medium transition"
              style={
                category === c
                  ? { background: "var(--accent-fill)", color: "var(--ink)" }
                  : { background: "var(--accent-soft)", color: "var(--accent)" }
              }
            >
              {c} <span style={{ opacity: 0.75 }}>({products.filter((p) => (p.category || UNCATEGORIZED) === c).length})</span>
            </button>
          ))}
        </div>

        {visibleProducts.length === 0 && (
          <p className="py-8 text-center text-sm" style={{ color: "var(--muted)" }}>
            No items match &ldquo;{search}&rdquo;.
          </p>
        )}

        <div className={view === "grid" ? "pos-product-grid" : "flex flex-col gap-2"}>
          {visibleProducts.slice(0, displayCount).map((p) => {
            const available = isAvailable(p);
            const addOnMark = p.modifierGroups.length > 0;
            const wrapperStyle = { borderColor: "var(--line)", opacity: available ? 1 : 0.55 };
            const hover = available ? "hover:border-[var(--accent)] hover:shadow-md hover:-translate-y-0.5" : "";
            const toggle = (
              <AvailabilitySwitch available={available} label={p.name} onToggle={() => toggleAvailability(p)} />
            );

            if (view === "list") {
              return (
                <div
                  key={p.id}
                  className={`flex items-center gap-3 rounded-xl border bg-white px-3 py-2.5 shadow-sm transition ${hover}`}
                  style={wrapperStyle}
                >
                  <ProductAvatar name={p.name} imageUrl={p.imageUrl} size={40} />
                  <button
                    type="button"
                    disabled={!available}
                    onClick={() => tapProduct(p)}
                    className="flex min-w-0 flex-1 items-center justify-between gap-3 text-left disabled:cursor-not-allowed"
                  >
                    <span className="min-w-0">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate font-semibold">{p.name}</span>
                        {addOnMark && (
                          <span
                            className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-bold"
                            style={{ background: "var(--accent-soft)", color: "var(--accent)" }}
                          >
                            +ADD-ON
                          </span>
                        )}
                      </span>
                      <span className="num block text-xs" style={{ color: "var(--muted)" }}>
                        {p.sku || "—"}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      {!available && <Badge tone="bad">Unavailable</Badge>}
                      <span className="num text-base font-bold" style={{ color: "var(--accent)" }}>
                        {formatMoney(priceFor(p, channel))}
                      </span>
                    </span>
                  </button>
                  {toggle}
                </div>
              );
            }

            return (
              <div
                key={p.id}
                  className={`pos-product-card relative flex min-w-0 flex-col rounded-2xl border bg-white p-3.5 shadow-sm transition ${hover}`}
                style={{ ...wrapperStyle, minHeight: 132 }}
              >
                <button
                  type="button"
                  disabled={!available}
                  onClick={() => tapProduct(p)}
                  className="flex min-w-0 flex-1 flex-col text-left disabled:cursor-not-allowed"
                >
                  <div className="mb-2">
                    <ProductAvatar name={p.name} imageUrl={p.imageUrl} size={36} />
                  </div>
                  <div className="min-w-0 break-words pr-7 text-[15px] font-semibold leading-snug">
                    {p.name}
                    {addOnMark && (
                      <span
                        className="ml-1.5 inline-block rounded-full px-1.5 py-0.5 align-middle text-[10px] font-bold"
                        style={{ background: "var(--accent-soft)", color: "var(--accent)" }}
                      >
                        +ADD-ON
                      </span>
                    )}
                  </div>
                  <div className="num text-xs" style={{ color: "var(--muted)" }}>
                    {p.sku || "—"}
                  </div>
                  <div className="mt-auto flex items-center justify-between pt-2">
                    <span className="num text-lg font-bold" style={{ color: "var(--accent)" }}>
                      {formatMoney(priceFor(p, channel))}
                    </span>
                    {!available && <Badge tone="bad">Unavailable</Badge>}
                  </div>
                </button>
                <div className="absolute right-2.5 top-2.5">{toggle}</div>
              </div>
            );
          })}
        </div>
        {visibleProducts.length > displayCount && <div className="pos-load-more">
          <span>Showing {displayCount} of {visibleProducts.length} items</span>
          <button type="button" className="btn-secondary" onClick={() => setDisplayCount(count => count + 36)}>Show more items</button>
        </div>}
      </section>

      <section id="pos-checkout" className="pos-checkout min-w-0 space-y-4">
        {qrQueueError && <p role="alert" className="text-sm" style={{ color: "var(--danger)" }}>{qrQueueError}</p>}
        {queuedQrOrders.length > 0 && (
          <div className="panel p-4" style={{ borderColor: "var(--accent)" }}>
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-lg font-semibold">QR orders</h2>
              <span
                className="num rounded-full px-2 py-0.5 text-xs font-bold"
                style={{ background: "var(--accent-soft)", color: "var(--accent)" }}
              >
                {queuedQrOrders.length}
              </span>
            </div>
            <div className="space-y-2">
              {queuedQrOrders.map((o) => (
                <div key={o.id} className="flex items-center justify-between gap-2 rounded-lg border p-2.5" style={{ borderColor: "var(--line)" }}>
                  <div className="min-w-0">
                    <p className="font-semibold">
                      <span className="num" style={{ color: "var(--accent)" }}>
                        {o.code}
                      </span>{" "}
                      — {o.customerName}
                    </p>
                    <p className="truncate text-xs" style={{ color: "var(--muted)" }}>
                      {o.lines.map((l) => `${l.quantity}× ${l.productName}`).join(", ")}
                    </p>
                    {o.note && <p className="mt-1 text-xs">Note: {o.note}</p>}
                    {o.status === "CLAIMED" && <p className="mt-1 text-xs" style={{ color: "var(--muted)" }}>In checkout · {o.claimedByName ?? "Unassigned"}{o.claimedById === currentUserId ? " (you) — resume original items" : ""}</p>}
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <span className="num text-sm font-medium">{formatMoney(o.totalCents)}</span>
                    {(o.status === "PENDING" || o.claimedById === currentUserId) && <button
                      type="button"
                      className="btn-primary !px-2.5 !py-1.5 text-xs"
                      disabled={pending || !!activeQrOrder}
                      onClick={() => claimQrOrder(o)}
                    >
                      {claimingQrOrderId === o.id ? "Loading…" : o.status === "CLAIMED" ? "Resume" : "Claim"}
                    </button>}
                    {o.status === "CLAIMED" && (o.claimedById === currentUserId || canVoid) && <button type="button" className="btn-secondary !px-2 !py-1.5 text-xs" disabled={pending} onClick={() => returnQrOrder(o.id)}>Return</button>}
                    {o.status === "PENDING" && <button type="button" aria-label={`Cancel QR order ${o.code}`} className="btn-secondary !px-2 !py-1.5 text-xs" disabled={pending} onClick={() => cancelQrOrder(o.id)}>
                      ✕
                    </button>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="panel pos-cart p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-lg font-semibold">Cart</h2>
            {lines.length > 0 && (
              <span
                className="num rounded-full px-2 py-0.5 text-xs font-bold"
                style={{ background: "var(--accent-soft)", color: "var(--accent)" }}
              >
                {(() => {
                  const qty = lines.reduce((s, l) => s + l.line.quantity, 0);
                  return `${qty} item${qty === 1 ? "" : "s"}`;
                })()}
              </span>
            )}
          </div>

          {activeQrOrder && <div className="mb-3 rounded-xl p-3 text-sm" style={{ background: "var(--accent-soft)" }}>
            <p className="font-semibold">QR {activeQrOrder.code} · {activeQrOrder.customerName}</p>
            {activeQrOrder.note && <p className="mt-1">{activeQrOrder.note}</p>}
            <button type="button" className="btn-secondary mt-2 text-xs" disabled={pending} onClick={() => returnQrOrder(activeQrOrder.id)}>Return to queue</button>
          </div>}
          {!activeQrOrder && cart.length > 0 && <button type="button" className="btn-secondary mb-3 text-xs" disabled={pending} onClick={() => { if (confirmed("Clear the current cart?")) setCart([]); }}>Clear cart</button>}
          <div className="mb-3 flex gap-1.5 rounded-xl p-1" style={{ background: "var(--bg)" }}>
            {(["WALK_IN", "FOODPANDA", "GRABFOOD"] as const).map((c) => (
              <button
                key={c}
                type="button"
                disabled={pending || !!activeQrOrder}
                className="flex-1 rounded-lg px-2 py-2 text-xs font-semibold transition"
                style={
                  channel === c
                    ? { background: "var(--accent-fill)", color: "var(--ink)" }
                    : { background: "transparent", color: "var(--muted)" }
                }
                onClick={() => setChannel(c)}
              >
                {CHANNEL_LABELS[c]}
              </button>
            ))}
          </div>

          {lines.length === 0 ? (
            <p className="pos-cart-empty">
              <span aria-hidden="true">✦</span>
              Your cart is empty.<small>Choose a menu item to start this sale.</small>
            </p>
          ) : (
            <ul className="space-y-1">
              {lines.map(({ line, product, unitCents }) => (
                <li
                  key={line.key}
                  className="flex items-center justify-between gap-2 rounded-lg px-2 py-2 text-sm transition hover:bg-[var(--bg)]"
                >
                  <div className="min-w-0">
                    <div className="truncate font-semibold">{product.name}</div>
                    {line.modifiers.length > 0 && (
                      <div className="truncate text-xs" style={{ color: "var(--muted)" }}>
                        {line.modifiers
                          .map((m) => (m.quantity > 1 ? `${m.name} ×${m.quantity}` : m.name))
                          .join(", ")}
                      </div>
                    )}
                    <div className="num text-xs" style={{ color: "var(--muted)" }}>
                      {formatMoney(unitCents)} × {line.quantity}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <button
                      type="button"
                      className="flex h-8 w-8 items-center justify-center rounded-lg border text-base font-bold"
                      style={{ borderColor: "var(--line)" }}
                      onClick={() => dec(line.key)}
                    >
                      −
                    </button>
                    <span className="num w-5 text-center font-semibold">{line.quantity}</span>
                    <button
                      type="button"
                      className="flex h-8 w-8 items-center justify-center rounded-lg border text-base font-bold"
                      style={{ borderColor: "var(--line)" }}
                      onClick={() => inc(line.key)}
                    >
                      +
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          <div className="mt-3 rounded-xl p-3.5" style={{ background: "var(--accent-soft)" }}>
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold" style={{ color: "var(--accent)" }}>
                Total
              </span>
              <span className="num text-3xl font-bold" style={{ color: "var(--accent)" }}>
                {formatMoney(totalCents)}
              </span>
            </div>
          </div>

          {channel === "WALK_IN" ? (
            <div className="mt-3 flex gap-2">
              {(["CASH", "CARD"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  className={paymentMethod === m ? "btn-primary flex-1" : "btn-secondary flex-1"}
                  onClick={() => setPaymentMethod(m)}
                >
                  {m}
                </button>
              ))}
            </div>
          ) : (
            <div className="mt-3">
              <label className="mb-1 block text-xs font-medium" style={{ color: "var(--muted)" }}>
                {CHANNEL_LABELS[channel]} order # (optional)
              </label>
              <input
                type="text"
                className="field w-full"
                value={externalRef}
                onChange={(e) => setExternalRef(e.target.value)}
                placeholder="e.g. FP-12345"
              />
              <p className="mt-1 text-xs" style={{ color: "var(--muted)" }}>
                Paid through {CHANNEL_LABELS[channel]}, not the cash drawer.
              </p>
            </div>
          )}

          {canOverrideStock && (
            <label className="mt-3 flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={allowNegative}
                onChange={(e) => setAllowNegative(e.target.checked)}
              />
              Allow sale with insufficient stock
            </label>
          )}

          <button
            type="button"
            className="btn-primary mt-4 w-full py-3.5 text-base font-bold"
            disabled={pending || lines.length === 0}
            onClick={checkout}
          >
            {pending ? "Processing…" : `Complete sale${lines.length ? " · " + formatMoney(totalCents) : ""}`}
          </button>

          {message && (
            <p className="mt-2 text-sm" style={{ color: "var(--accent)" }}>
              {message}
            </p>
          )}
          {error && (
            <p className="mt-2 text-sm" style={{ color: "var(--danger)" }}>
              {error}
            </p>
          )}
        </div>

        <div className="panel p-4">
          <h2 className="mb-3 text-lg font-semibold">Recent sales</h2>
          <table className="table">
            <thead>
              <tr>
                <th>When</th>
                <th>Total</th>
                <th>Channel</th>
                <th>Pay</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {recentSales.map((s) => (
                <tr key={s.id}>
                  <td className="whitespace-nowrap text-xs">
                    {new Date(s.createdAt).toLocaleString()}
                    <div style={{ color: "var(--muted)" }}>{s.cashierName}</div>
                  </td>
                  <td className="num">
                    {formatMoney(s.totalCents)}
                    {s.status === "VOIDED" && (
                      <span className="ml-1">
                        <Badge tone="bad">void</Badge>
                      </span>
                    )}
                  </td>
                  <td className="text-xs">
                    {s.channel === "WALK_IN" ? "Walk-in" : CHANNEL_LABELS[s.channel]}
                    {s.externalRef && <div style={{ color: "var(--muted)" }}>{s.externalRef}</div>}
                  </td>
                  <td>{s.paymentMethod}</td>
                  <td>
                    {canVoid && s.status === "COMPLETED" && (
                      <button
                        type="button"
                        className="btn-secondary px-2 py-1 text-xs"
                        disabled={pending}
                        onClick={() => voidSale(s.id)}
                      >
                        Void
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {lines.length > 0 && <button type="button" className="pos-mobile-cart" onClick={() => document.getElementById("pos-checkout")?.scrollIntoView({ behavior: "smooth", block: "start" })}>
        <span>View cart <strong>{lines.reduce((sum, item) => sum + item.line.quantity, 0)} items</strong></span>
        <span className="num">{formatMoney(totalCents)} →</span>
      </button>}
      {pickerProduct && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: "rgba(36, 26, 20, 0.45)" }}
          onClick={() => setPickerProduct(null)}
        >
          <div
            className="panel max-h-[85vh] w-full max-w-md overflow-y-auto p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-1 flex items-center gap-3">
              <ProductAvatar name={pickerProduct.name} imageUrl={pickerProduct.imageUrl} size={44} />
              <div className="min-w-0 flex-1">
                <h3 className="truncate text-lg font-semibold">{pickerProduct.name}</h3>
                <span className="num text-sm font-semibold" style={{ color: "var(--accent)" }}>
                  {formatMoney(priceFor(pickerProduct, channel))}
                </span>
              </div>
            </div>

            <div className="space-y-4 py-2">
              {pickerProduct.modifierGroups.map((group) => (
                <div key={group.id}>
                  <div className="mb-2 text-sm font-medium">
                    {group.name}
                    {group.required && (
                      <span className="ml-1 text-xs" style={{ color: "var(--danger)" }}>
                        required
                      </span>
                    )}
                  </div>
                  <ul className="space-y-1">
                    {group.modifiers.map((m) => {
                      const selected = pickerSelections[m.id];
                      if (group.selectionType === "SINGLE") {
                        return (
                          <li key={m.id}>
                            <button
                              type="button"
                              onClick={() => chooseSingle(group, m)}
                              className="flex w-full items-center justify-between rounded-lg border px-3 py-3 text-left text-sm transition"
                              style={{
                                borderColor: selected ? "var(--accent)" : "var(--line)",
                                background: selected ? "var(--accent-soft)" : "transparent",
                              }}
                            >
                              <span>{m.name}</span>
                              <span className="num" style={{ color: "var(--muted)" }}>
                                {m.priceCents > 0 ? formatMoney(m.priceCents) : ""}
                              </span>
                            </button>
                          </li>
                        );
                      }
                      return (
                        <li
                          key={m.id}
                          className="flex items-center justify-between gap-2 rounded-lg border px-3 py-3 text-sm"
                          style={{
                            borderColor: selected ? "var(--accent)" : "var(--line)",
                            background: selected ? "var(--accent-soft)" : "transparent",
                          }}
                        >
                          <button type="button" className="flex-1 text-left" onClick={() => toggleMulti(m)}>
                            <div>{m.name}</div>
                            <div className="num text-xs" style={{ color: "var(--muted)" }}>
                              {formatMoney(m.priceCents)}
                            </div>
                          </button>
                          {selected && (
                            <div className="flex items-center gap-1.5">
                              <button
                                type="button"
                                className="flex h-8 w-8 items-center justify-center rounded-lg border text-base font-bold"
                                style={{ borderColor: "var(--line)" }}
                                onClick={() => changeMultiQty(m, selected.quantity - 1)}
                              >
                                −
                              </button>
                              <span className="num w-5 text-center font-semibold">{selected.quantity}</span>
                              <button
                                type="button"
                                className="flex h-8 w-8 items-center justify-center rounded-lg border text-base font-bold"
                                style={{ borderColor: "var(--line)" }}
                                onClick={() => changeMultiQty(m, selected.quantity + 1)}
                              >
                                +
                              </button>
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </div>

            {pickerError && (
              <p className="mb-2 text-sm" style={{ color: "var(--danger)" }}>
                {pickerError}
              </p>
            )}

            <div className="mt-2 rounded-xl p-3" style={{ background: "var(--accent-soft)" }}>
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold" style={{ color: "var(--accent)" }}>
                  Total
                </span>
                <span className="num text-2xl font-bold" style={{ color: "var(--accent)" }}>
                  {formatMoney(priceFor(pickerProduct, channel) + modifiersTotalCents(Object.values(pickerSelections)))}
                </span>
              </div>
            </div>

            <div className="mt-3 flex gap-2">
              <button type="button" className="btn-secondary flex-1" onClick={() => setPickerProduct(null)}>
                Cancel
              </button>
              <button type="button" className="btn-primary flex-1 py-3 text-base font-bold" onClick={confirmPicker}>
                Add to cart
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
