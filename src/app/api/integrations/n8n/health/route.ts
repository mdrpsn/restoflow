import { integrationErrorResponse, requireIntegrationAuth } from "@/lib/integrationAuth";
import { getIntegrationHealth } from "@/lib/integrationEvents";

export async function GET(request: Request) {
  try {
    const { organizationId } = requireIntegrationAuth(request);
    const branchCode = new URL(request.url).searchParams.get("branch")?.trim().toUpperCase() || undefined;
    const health = await getIntegrationHealth(organizationId, branchCode);
    // A degraded integration is valid monitoring data, not an HTTP transport failure.
    return Response.json(health);
  } catch (error) {
    return integrationErrorResponse(error);
  }
}
