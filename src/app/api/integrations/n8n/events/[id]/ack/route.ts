import { Prisma } from "@prisma/client";
import { acknowledgeIntegrationEvent } from "@/lib/integrationEvents";
import {
  IntegrationAuthError,
  integrationErrorResponse,
  requireIdempotencyKey,
  requireIntegrationAuth,
  runIdempotentMutation,
} from "@/lib/integrationAuth";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { organizationId } = requireIntegrationAuth(request);
    const idempotencyKey = requireIdempotencyKey(request);
    const { id } = await context.params;
    const result = await runIdempotentMutation<Prisma.InputJsonValue>({
      organizationId,
      operation: `event.ack:${id}`,
      idempotencyKey,
      run: async () => {
        const event = await acknowledgeIntegrationEvent({ organizationId, eventId: id });
        if (!event) throw new IntegrationAuthError("Event not found", 404);
        return { id: event.id, acknowledgedAt: event.acknowledgedAt?.toISOString() ?? null };
      },
    });
    return Response.json({ ...result.response as object, replayed: result.replayed });
  } catch (error) {
    return integrationErrorResponse(error);
  }
}
