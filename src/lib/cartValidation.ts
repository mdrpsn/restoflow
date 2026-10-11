import { z } from "zod";
import { StockError } from "@/lib/stock";

const linesSchema = z.array(z.object({
  productId: z.string().min(1),
  quantity: z.number().int().min(1).max(999),
  modifiers: z.array(z.object({
    modifierId: z.string().min(1),
    quantity: z.number().int().min(1).max(999),
  })).max(50).optional(),
})).min(1).max(100);

export function validateCartLines(lines: unknown) {
  if (!linesSchema.safeParse(lines).success) {
    throw new StockError("Use 1–100 cart lines with whole item quantities from 1 to 999");
  }
}

export function validateTotalCents(total: number) {
  if (!Number.isSafeInteger(total) || total < 0 || total > 2_147_483_647) {
    throw new StockError("Order total is too large or invalid");
  }
}
