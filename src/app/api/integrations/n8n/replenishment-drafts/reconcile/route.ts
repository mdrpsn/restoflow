import { Prisma } from "@prisma/client";
import {
  integrationErrorResponse,
  requireIdempotencyKey,
  requireIntegrationAuth,
  runIdempotentMutation,
} from "@/lib/integrationAuth";
import { reconcileAutomatedStockRequest } from "@/lib/stockRequests";

export async function POST(request: Request) {
  try {
    const { organizationId } = requireIntegrationAuth(request);
    const idempotencyKey = requireIdempotencyKey(request);
    const body = await request.json().catch(() => ({})) as { branchCode?: string };
    const branchCode = String(body.branchCode ?? "MAIN").trim().toUpperCase();
    if (!branchCode) return Response.json({ error: "branchCode is required" }, { status: 400 });

    const result = await runIdempotentMutation<Prisma.InputJsonValue>({
      organizationId,
      operation: `replenishment.reconcile:${branchCode}`,
      idempotencyKey,
      run: async () => {
        const reconciled = await reconcileAutomatedStockRequest({ organizationId, branchCode });
        return {
          changed: reconciled.changed,
          branch: { id: reconciled.branch.id, code: reconciled.branch.code, name: reconciled.branch.name },
          draft: reconciled.draft ? {
            id: reconciled.draft.id,
            path: "/requests",
            lines: reconciled.draft.lines.map((line) => ({
              ingredientId: line.ingredientId,
              ingredientName: line.ingredient.name,
              unit: line.ingredient.unit,
              quantity: line.quantity.toString(),
            })),
          } : null,
        };
      },
    });
    return Response.json({ ...result.response as object, replayed: result.replayed });
  } catch (error) {
    return integrationErrorResponse(error);
  }
}
