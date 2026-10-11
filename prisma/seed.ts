import { PrismaClient, Role, BranchType, PaymentMethod, SalesChannel } from "@prisma/client";
import { hash } from "bcryptjs";

const prisma = new PrismaClient();

// Synthetic demo data. Every name, price, cost and sale below is invented; none of it comes
// from a real business. It exists so the app has something realistic to show on first run.

function makeRng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}
const rng = makeRng(42);
const pick = <T,>(items: T[]): T => items[Math.floor(rng() * items.length)];

const SUPPLIERS = ["Fresh Farms Supply", "Northside Dry Goods", "Bay Packaging Co."];

type Ing = { name: string; unit: string; cost: number; supplier: number; low: number };
const INGREDIENTS: Ing[] = [
  { name: "Black Tea Leaves", unit: "g", cost: 0.45, supplier: 1, low: 500 },
  { name: "Green Tea Leaves", unit: "g", cost: 0.5, supplier: 1, low: 500 },
  { name: "Milk Powder", unit: "g", cost: 0.32, supplier: 1, low: 2000 },
  { name: "Fructose Syrup", unit: "ml", cost: 0.18, supplier: 0, low: 3000 },
  { name: "Tapioca Pearls", unit: "g", cost: 0.12, supplier: 1, low: 2000 },
  { name: "Cream Cheese", unit: "g", cost: 0.55, supplier: 0, low: 1000 },
  { name: "Passion Fruit Pulp", unit: "ml", cost: 0.3, supplier: 0, low: 1500 },
  { name: "Fresh Lemon", unit: "pcs", cost: 6, supplier: 0, low: 30 },
  { name: "Coffee Beans", unit: "g", cost: 0.9, supplier: 1, low: 1000 },
  { name: "Fresh Milk", unit: "ml", cost: 0.09, supplier: 0, low: 5000 },
  { name: "Cup 16oz", unit: "pcs", cost: 3.2, supplier: 2, low: 300 },
  { name: "Cup 22oz", unit: "pcs", cost: 3.8, supplier: 2, low: 300 },
  { name: "Lid", unit: "pcs", cost: 0.8, supplier: 2, low: 400 },
  { name: "Straw", unit: "pcs", cost: 0.4, supplier: 2, low: 400 },
  { name: "Cooked Rice", unit: "g", cost: 0.05, supplier: 1, low: 5000 },
  { name: "Frozen Pork Dumplings", unit: "pcs", cost: 5.5, supplier: 0, low: 100 },
  { name: "Chicken Thigh Fillet", unit: "g", cost: 0.28, supplier: 0, low: 3000 },
  { name: "Egg", unit: "pcs", cost: 8, supplier: 0, low: 60 },
  { name: "Cooking Oil", unit: "ml", cost: 0.12, supplier: 1, low: 2000 },
  { name: "Soy Glaze", unit: "ml", cost: 0.2, supplier: 1, low: 1000 },
  { name: "Takoyaki Batter Mix", unit: "g", cost: 0.15, supplier: 1, low: 2000 },
  { name: "Octopus Bits", unit: "g", cost: 0.65, supplier: 0, low: 1000 },
  { name: "Takoyaki Sauce", unit: "ml", cost: 0.22, supplier: 1, low: 800 },
];

const PACKS: { ingredient: string; name: string; size: number }[] = [
  { ingredient: "Fructose Syrup", name: "2000ml jug", size: 2000 },
  { ingredient: "Tapioca Pearls", name: "1kg bag", size: 1000 },
  { ingredient: "Cup 16oz", name: "50pc sleeve", size: 50 },
  { ingredient: "Cup 22oz", name: "50pc sleeve", size: 50 },
];

// Fructose per serving by sweetness level (ml). Large uses 1.5x.
const FRUCTOSE_BY_SWEETNESS: Record<number, number> = { 25: 10, 50: 20, 75: 30, 100: 40 };
const SWEETNESS_LEVELS = [25, 50, 75, 100];

type Recipe = [ingredient: string, qty: number][];
type ProductDef = {
  name: string;
  sku: string;
  category: string;
  priceCents: number;
  recipe: Recipe;
  sweetened?: { sizeFactor: number };
};

const PRODUCTS: ProductDef[] = [
  {
    name: "Classic Milk Tea (Medium)", sku: "MT-CLASSIC-M", category: "Milk Tea", priceCents: 8500,
    recipe: [["Black Tea Leaves", 6], ["Milk Powder", 25], ["Cup 16oz", 1], ["Lid", 1], ["Straw", 1]],
    sweetened: { sizeFactor: 1 },
  },
  {
    name: "Classic Milk Tea (Large)", sku: "MT-CLASSIC-L", category: "Milk Tea", priceCents: 10500,
    recipe: [["Black Tea Leaves", 9], ["Milk Powder", 35], ["Cup 22oz", 1], ["Lid", 1], ["Straw", 1]],
    sweetened: { sizeFactor: 1.5 },
  },
  {
    name: "Cream Cheese Milk Tea (Medium)", sku: "CC-MT-M", category: "Cream Cheese Tea", priceCents: 11000,
    recipe: [["Black Tea Leaves", 6], ["Milk Powder", 25], ["Cream Cheese", 30], ["Cup 16oz", 1], ["Lid", 1], ["Straw", 1]],
    sweetened: { sizeFactor: 1 },
  },
  {
    name: "Cream Cheese Milk Tea (Large)", sku: "CC-MT-L", category: "Cream Cheese Tea", priceCents: 13000,
    recipe: [["Black Tea Leaves", 9], ["Milk Powder", 35], ["Cream Cheese", 45], ["Cup 22oz", 1], ["Lid", 1], ["Straw", 1]],
    sweetened: { sizeFactor: 1.5 },
  },
  {
    name: "Passion Fruit Tea (Large)", sku: "FT-PASSION-L", category: "Fruit Tea", priceCents: 11500,
    recipe: [["Green Tea Leaves", 8], ["Passion Fruit Pulp", 40], ["Fresh Lemon", 0.5], ["Cup 22oz", 1], ["Lid", 1], ["Straw", 1]],
    sweetened: { sizeFactor: 1.5 },
  },
  {
    name: "Iced Latte (Medium)", sku: "COFFEE-LATTE-M", category: "Coffee", priceCents: 9500,
    recipe: [["Coffee Beans", 18], ["Fresh Milk", 150], ["Cup 16oz", 1], ["Lid", 1], ["Straw", 1]],
  },
  {
    name: "Pork Dumplings (6 pcs)", sku: "FOOD-DUMPLING-6", category: "Snacks", priceCents: 12000,
    recipe: [["Frozen Pork Dumplings", 6], ["Cooking Oil", 5], ["Soy Glaze", 10]],
  },
  {
    name: "Chicken Rice Bowl", sku: "FOOD-CHICKEN-BOWL", category: "Rice Meals", priceCents: 14500,
    recipe: [["Cooked Rice", 200], ["Chicken Thigh Fillet", 150], ["Egg", 1], ["Soy Glaze", 20], ["Cooking Oil", 10]],
  },
  {
    name: "Takoyaki (6 pcs)", sku: "FOOD-TAKO-6", category: "Snacks", priceCents: 11000,
    recipe: [["Takoyaki Batter Mix", 60], ["Octopus Bits", 24], ["Takoyaki Sauce", 15], ["Cooking Oil", 8]],
  },
];

async function main() {
  // Full wipe, children first. Intended for local demo databases only.
  await prisma.stockMovement.deleteMany();
  await prisma.saleLineModifier.deleteMany();
  await prisma.saleLine.deleteMany();
  await prisma.sale.deleteMany();
  await prisma.productModifierGroup.deleteMany();
  await prisma.modifier.deleteMany();
  await prisma.modifierGroup.deleteMany();
  await prisma.stockTransferLine.deleteMany();
  await prisma.stockTransfer.deleteMany();
  await prisma.purchaseOrderLine.deleteMany();
  await prisma.purchaseOrder.deleteMany();
  await prisma.stockRequestLine.deleteMany();
  await prisma.stockRequest.deleteMany();
  await prisma.stockItem.deleteMany();
  await prisma.recipeLine.deleteMany();
  await prisma.product.deleteMany();
  await prisma.ingredient.deleteMany();
  await prisma.supplier.deleteMany();
  await prisma.userBranch.deleteMany();
  await prisma.user.deleteMany();
  await prisma.branch.deleteMany();
  await prisma.organization.deleteMany();

  const org = await prisma.organization.create({ data: { name: "We Got Cha! Demo" } });

  const branchDefs = [
    { name: "Downtown", code: "DT", type: BranchType.STORE },
    { name: "Riverside", code: "RS", type: BranchType.STORE },
    { name: "Uptown", code: "UT", type: BranchType.STORE },
    { name: "Warehouse", code: "WH", type: BranchType.WAREHOUSE },
  ];
  const branches = await Promise.all(
    branchDefs.map((b) => prisma.branch.create({ data: { organizationId: org.id, ...b } })),
  );
  const storeBranches = branches.filter((b) => b.type === BranchType.STORE);
  const warehouse = branches.find((b) => b.type === BranchType.WAREHOUSE)!;

  const passwordHash = await hash("password123", 10);
  const owner = await prisma.user.create({
    data: { organizationId: org.id, email: "owner@demo.local", name: "Demo Owner", passwordHash, role: Role.OWNER },
  });
  await prisma.user.create({
    data: {
      organizationId: org.id, email: "manager@demo.local", name: "Demo Manager", passwordHash, role: Role.MANAGER,
      branches: { create: branches.map((b) => ({ branchId: b.id })) },
    },
  });
  const cashier = await prisma.user.create({
    data: {
      organizationId: org.id, email: "cashier@demo.local", name: "Demo Cashier", passwordHash, role: Role.CASHIER,
      branches: { create: storeBranches.map((b) => ({ branchId: b.id })) },
    },
  });

  await prisma.supplier.createMany({ data: SUPPLIERS.map((name) => ({ organizationId: org.id, name })) });
  const suppliers = await prisma.supplier.findMany({ where: { organizationId: org.id } });
  const supplierId = (i: number) => suppliers.find((s) => s.name === SUPPLIERS[i])!.id;

  await prisma.ingredient.createMany({
    data: INGREDIENTS.map((i) => ({
      organizationId: org.id,
      name: i.name,
      unit: i.unit,
      costCentsPerUnit: Math.round(i.cost * 100),
      defaultSupplierId: supplierId(i.supplier),
      defaultLowStockAt: i.low,
    })),
  });
  const ingredients = await prisma.ingredient.findMany({ where: { organizationId: org.id } });
  const ingId = (name: string) => {
    const found = ingredients.find((i) => i.name === name);
    if (!found) throw new Error(`Seed: unknown ingredient "${name}"`);
    return found.id;
  };

  await prisma.ingredientPack.createMany({
    data: PACKS.map((p) => ({ ingredientId: ingId(p.ingredient), name: p.name, size: p.size, isDefault: true })),
  });

  await prisma.product.createMany({
    data: PRODUCTS.map((p) => ({
      organizationId: org.id, name: p.name, sku: p.sku, category: p.category, priceCents: p.priceCents,
    })),
  });
  const products = await prisma.product.findMany({ where: { organizationId: org.id } });
  const productBySku = new Map(products.map((p) => [p.sku!, p]));

  // Recipes. Sweetened drinks get one fructose line per sweetness level.
  const recipeRows: { productId: string; ingredientId: string; quantity: number; sweetnessPercent: number | null }[] = [];
  for (const def of PRODUCTS) {
    const product = productBySku.get(def.sku)!;
    for (const [ingredient, qty] of def.recipe) {
      recipeRows.push({ productId: product.id, ingredientId: ingId(ingredient), quantity: qty, sweetnessPercent: null });
    }
    if (def.sweetened) {
      for (const level of SWEETNESS_LEVELS) {
        recipeRows.push({
          productId: product.id,
          ingredientId: ingId("Fructose Syrup"),
          quantity: FRUCTOSE_BY_SWEETNESS[level] * def.sweetened.sizeFactor,
          sweetnessPercent: level,
        });
      }
    }
  }
  await prisma.recipeLine.createMany({ data: recipeRows });

  // Modifier groups: a required sweetness choice and optional add-ons.
  const sweetness = await prisma.modifierGroup.create({
    data: {
      organizationId: org.id, name: "Sweetness Level", selectionType: "SINGLE", required: true,
      modifiers: { create: SWEETNESS_LEVELS.map((level) => ({ name: `${level}%`, priceCents: 0, sweetnessPercent: level })) },
    },
  });
  const addOns = await prisma.modifierGroup.create({
    data: {
      organizationId: org.id, name: "Add-Ons", selectionType: "MULTI", required: false,
      modifiers: {
        create: [
          { name: "Tapioca Pearls", priceCents: 2000, ingredientId: ingId("Tapioca Pearls"), ingredientQty: 40 },
          { name: "Extra Cream Cheese", priceCents: 4000, ingredientId: ingId("Cream Cheese"), ingredientQty: 20 },
          { name: "Pudding", priceCents: 2500 },
        ],
      },
    },
  });
  const links: { productId: string; modifierGroupId: string }[] = [];
  for (const def of PRODUCTS) {
    const product = productBySku.get(def.sku)!;
    if (def.sweetened) links.push({ productId: product.id, modifierGroupId: sweetness.id });
    if (def.sweetened || def.sku === "COFFEE-LATTE-M") links.push({ productId: product.id, modifierGroupId: addOns.id });
  }
  await prisma.productModifierGroup.createMany({ data: links });

  // Stock on hand at every location. A few items at Riverside are set below their
  // threshold so the low-stock alerts have something to show.
  const stockRows: { branchId: string; ingredientId: string; quantity: number; lowStockAt: number; parLevel: number }[] = [];
  for (const branch of branches) {
    const scale = branch.type === BranchType.WAREHOUSE ? 6 : 1;
    for (const ing of INGREDIENTS) {
      let qty = ing.low * scale * (0.8 + rng() * 2.2);
      if (branch.code === "RS" && ["Fructose Syrup", "Cup 22oz", "Milk Powder"].includes(ing.name)) qty = ing.low * 0.4;
      stockRows.push({
        branchId: branch.id,
        ingredientId: ingId(ing.name),
        quantity: Math.round(qty),
        lowStockAt: ing.low * scale,
        parLevel: ing.low * scale * 3,
      });
    }
  }
  await prisma.stockItem.createMany({ data: stockRows });

  // 21 days of invented sales across the store branches, so the reports have data.
  const DAYS = 21;
  let saleCount = 0;
  for (let d = DAYS - 1; d >= 0; d--) {
    const day = new Date();
    day.setDate(day.getDate() - d);
    const weekend = [0, 6].includes(day.getDay());
    for (const branch of storeBranches) {
      const perDay = Math.round((weekend ? 34 : 24) * (0.8 + rng() * 0.4));
      const batch = [];
      for (let n = 0; n < perDay; n++) {
        const when = new Date(day);
        when.setHours(10 + Math.floor(rng() * 11), Math.floor(rng() * 60), 0, 0);
        const lineDefs = Array.from({ length: 1 + Math.floor(rng() * 3) }, () => {
          const def = pick(PRODUCTS);
          const product = productBySku.get(def.sku)!;
          const quantity = rng() < 0.2 ? 2 : 1;
          return {
            productId: product.id,
            quantity,
            unitCents: product.priceCents,
            totalCents: product.priceCents * quantity,
            recipeVersion: 1,
            sweetnessPercent: def.sweetened ? pick(SWEETNESS_LEVELS) : null,
          };
        });
        const platform = rng() < 0.12;
        batch.push(
          prisma.sale.create({
            data: {
              branchId: branch.id,
              cashierId: cashier.id,
              paymentMethod: platform ? PaymentMethod.PLATFORM : rng() < 0.7 ? PaymentMethod.CASH : PaymentMethod.CARD,
              channel: platform ? SalesChannel.FOODPANDA : SalesChannel.WALK_IN,
              totalCents: lineDefs.reduce((sum, l) => sum + l.totalCents, 0),
              createdAt: when,
              lines: { create: lineDefs },
            },
          }),
        );
        saleCount++;
      }
      await Promise.all(batch);
    }
  }

  console.log("Seeded synthetic demo data");
  console.log({
    org: org.name,
    branches: branches.map((b) => b.code),
    logins: [owner.email, "manager@demo.local", cashier.email],
    password: "password123",
    ingredients: INGREDIENTS.length,
    products: PRODUCTS.length,
    sales: saleCount,
    warehouse: warehouse.code,
  });
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
