import { Decimal } from "@prisma/client/runtime/library";
import { StockError } from "@/lib/stock";

export type ModifierOption = {
  id: string;
  name: string;
  priceCents: number;
  active: boolean;
  ingredientId: string | null;
  ingredientQty: Decimal | null;
  sweetnessPercent: number | null;
};

export type ModifierGroupForValidation = {
  id: string;
  name: string;
  selectionType: "SINGLE" | "MULTI";
  required: boolean;
  active: boolean;
  modifiers: ModifierOption[];
};

export type ModifierSelectionInput = { modifierId: string; quantity: number };

export type ModifierSelectionLine = {
  modifierId: string;
  name: string;
  priceCents: number;
  quantity: number;
  ingredientId: string | null;
  ingredientQty: Decimal | null;
  sweetnessPercent: number | null;
};

/** The Sweetness Level picked on a line (25/50/75/100), or null if none was. */
export function selectedSweetness(lines: { sweetnessPercent: number | null }[]): number | null {
  return lines.find((l) => l.sweetnessPercent != null)?.sweetnessPercent ?? null;
}

/**
 * Validates a cart line's modifier selections against the groups actually offered
 * on that product (see ProductModifierGroup), enforces SINGLE-group required/at-most-one
 * rules, and prices the result. Shared by completeSale() and its tests so sale-time
 * pricing/validation can't drift from what's checked here.
 */
export function validateModifierSelections(
  groups: ModifierGroupForValidation[],
  selections: ModifierSelectionInput[],
  productName: string,
): { priceCents: number; lines: ModifierSelectionLine[] } {
  const modifierIndex = new Map<string, { group: ModifierGroupForValidation; modifier: ModifierOption }>();
  for (const group of groups) {
    if (!group.active) continue;
    for (const modifier of group.modifiers) {
      if (!modifier.active) continue;
      modifierIndex.set(modifier.id, { group, modifier });
    }
  }

  let priceCents = 0;
  const lines: ModifierSelectionLine[] = [];
  const selectedGroupIds = new Set<string>();

  for (const selection of selections) {
    if (!Number.isInteger(selection.quantity) || selection.quantity <= 0) {
      throw new StockError(`Invalid modifier quantity for "${productName}"`);
    }
    const found = modifierIndex.get(selection.modifierId);
    if (!found) {
      throw new StockError(`"${productName}" does not offer that add-on/option`);
    }
    const { group, modifier } = found;

    if (group.selectionType === "SINGLE") {
      if (selection.quantity !== 1) {
        throw new StockError(`"${group.name}" only allows one selection`);
      }
      if (selectedGroupIds.has(group.id)) {
        throw new StockError(`Only one choice allowed for "${group.name}"`);
      }
    }
    selectedGroupIds.add(group.id);

    priceCents += modifier.priceCents * selection.quantity;
    lines.push({
      modifierId: modifier.id,
      name: modifier.name,
      priceCents: modifier.priceCents,
      quantity: selection.quantity,
      ingredientId: modifier.ingredientId,
      ingredientQty: modifier.ingredientQty,
      sweetnessPercent: modifier.sweetnessPercent,
    });
  }

  for (const group of groups) {
    if (group.active && group.required && !selectedGroupIds.has(group.id)) {
      throw new StockError(`"${group.name}" is required for "${productName}"`);
    }
  }

  return { priceCents, lines };
}

/** Ingredient consumption implied by a set of already-validated modifier selection lines, keyed by ingredientId. */
export function aggregateModifierConsumption(
  lines: { modifiers: ModifierSelectionLine[]; quantitySold: number }[],
): Map<string, Decimal> {
  const needs = new Map<string, Decimal>();
  for (const line of lines) {
    for (const selection of line.modifiers) {
      if (!selection.ingredientId || !selection.ingredientQty) continue;
      const add = new Decimal(selection.ingredientQty).mul(selection.quantity).mul(line.quantitySold);
      const prev = needs.get(selection.ingredientId) ?? new Decimal(0);
      needs.set(selection.ingredientId, prev.plus(add));
    }
  }
  return needs;
}
