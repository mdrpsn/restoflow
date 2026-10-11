import { createHash, timingSafeEqual } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export class IntegrationAuthError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "IntegrationAuthError";
  }
}

function digest(value: string) {
  return createHash("sha256").update(value).digest();
}

export function requireIntegrationAuth(request: Request) {
  const expectedToken = process.env.N8N_INTEGRATION_TOKEN;
  const organizationId = process.env.N8N_ORGANIZATION_ID;
  if (!expectedToken || !organizationId) {
    throw new IntegrationAuthError("n8n integration is not configured", 503);
  }

  const authorization = request.headers.get("authorization") ?? "";
  const suppliedToken = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : "";
  if (!suppliedToken || !timingSafeEqual(digest(suppliedToken), digest(expectedToken))) {
    throw new IntegrationAuthError("Unauthorized", 401);
  }
  return { organizationId };
}

export function requireIdempotencyKey(request: Request) {
  const key = request.headers.get("idempotency-key")?.trim();
  if (!key || key.length > 200) {
    throw new IntegrationAuthError("A valid Idempotency-Key header is required", 400);
  }
  return key;
}

export async function runIdempotentMutation<T extends Prisma.InputJsonValue>(params: {
  organizationId: string;
  operation: string;
  idempotencyKey: string;
  run: () => Promise<T>;
}): Promise<{ response: T; replayed: boolean }> {
  const existing = await prisma.integrationMutation.findUnique({
    where: {
      organizationId_operation_idempotencyKey: {
        organizationId: params.organizationId,
        operation: params.operation,
        idempotencyKey: params.idempotencyKey,
      },
    },
  });
  if (existing) return { response: existing.response as T, replayed: true };

  const response = await params.run();
  try {
    await prisma.integrationMutation.create({
      data: {
        organizationId: params.organizationId,
        operation: params.operation,
        idempotencyKey: params.idempotencyKey,
        response,
      },
    });
    return { response, replayed: false };
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
      throw error;
    }
    const winner = await prisma.integrationMutation.findUniqueOrThrow({
      where: {
        organizationId_operation_idempotencyKey: {
          organizationId: params.organizationId,
          operation: params.operation,
          idempotencyKey: params.idempotencyKey,
        },
      },
    });
    return { response: winner.response as T, replayed: true };
  }
}

export function integrationErrorResponse(error: unknown) {
  if (error instanceof IntegrationAuthError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  const message = error instanceof Error ? error.message : "Unexpected integration error";
  return Response.json({ error: message }, { status: 500 });
}
