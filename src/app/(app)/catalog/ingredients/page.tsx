import { deleteIngredientPackAction, upsertIngredientAction, upsertIngredientPackAction } from "@/actions";
import { formatNumber } from "@/lib/packs";
import { prisma } from "@/lib/prisma";
import { requireManager } from "@/lib/session";
import { formatMoney } from "@/lib/money";
import { IngredientsBrowser } from "@/components/ingredients-browser";

async function upsertIngredientFormAction(formData: FormData) {
  "use server";
  await upsertIngredientAction(formData);
}

async function upsertIngredientPackFormAction(formData: FormData) {
  "use server";
  await upsertIngredientPackAction(formData);
}

async function deleteIngredientPackFormAction(formData: FormData) {
  "use server";
  await deleteIngredientPackAction(formData);
}

export default async function IngredientsPage() {
  const user = await requireManager();
  const ingredients = await prisma.ingredient.findMany({
    where: { organizationId: user.organizationId },
    include: { packs: { orderBy: { size: "asc" } } },
    orderBy: { name: "asc" },
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Ingredients</h1>
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          Stockable items used in recipes and purchasing. Stock is always held in the unit shown here;
          packs (a bar, bottle, tub…) are just a shortcut for typing quantities in, worth a fixed number of that unit.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1.2fr_1fr]">
        <IngredientsBrowser deletePack={deleteIngredientPackFormAction} ingredients={ingredients.map(i => ({
          id: i.id, name: i.name, unit: i.unit, cost: formatMoney(i.costCentsPerUnit),
          packs: i.packs.map(p => ({ id: p.id, name: p.name, size: formatNumber(Number(p.size)), isDefault: p.isDefault })),
        }))} />

        <div className="space-y-6">
        <form action={upsertIngredientFormAction} className="panel space-y-3 p-4">
          <h2 className="font-semibold">Add ingredient</h2>
          <div>
            <label className="label">Name</label>
            <input name="name" className="field" required />
          </div>
          <div>
            <label className="label">Unit (pcs, g, ml…)</label>
            <input name="unit" className="field" required placeholder="pcs" />
          </div>
          <div>
            <label className="label">Cost per unit (PHP)</label>
            <input name="cost" className="field" defaultValue="0" />
          </div>
          <button type="submit" className="btn-primary w-full">
            Create
          </button>
        </form>

        <form action={upsertIngredientPackFormAction} className="panel space-y-3 p-4">
          <h2 className="font-semibold">Add / update a pack</h2>
          <div>
            <label className="label">Ingredient</label>
            <select name="ingredientId" className="field" required>
              {ingredients.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name} ({i.unit})
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Pack name</label>
            <input name="name" className="field" required placeholder="430g bar" />
          </div>
          <div>
            <label className="label">Pack size (in the ingredient&apos;s unit)</label>
            <input name="size" className="field" required type="number" step="any" min="0.0001" placeholder="430" />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input name="isDefault" type="checkbox" /> Default pack (used for the warehouse &quot;3 × bar&quot; hint)
          </label>
          <button type="submit" className="btn-secondary w-full">
            Save pack
          </button>
        </form>
        </div>
      </div>
    </div>
  );
}
