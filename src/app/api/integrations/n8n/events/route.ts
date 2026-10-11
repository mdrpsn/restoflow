import { getPendingIntegrationEvents } from "@/lib/integrationEvents";
import { integrationErrorResponse, requireIntegrationAuth } from "@/lib/integrationAuth";

export async function GET(request: Request) {
  try {
    const { organizationId } = requireIntegrationAuth(request);
    const url = new URL(request.url);
    const limit = Number(url.searchParams.get("limit") ?? "50");
    const branchCode = url.searchParams.get("branch")?.trim().toUpperCase() || undefined;
    const events = await getPendingIntegrationEvents({ organizationId, branchCode, limit });
    return Response.json({ events });
  } catch (error) {
    return integrationErrorResponse(error);
  }
}
