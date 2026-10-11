import { getDailyOperationsSummary } from "@/lib/dailySummary";
import { integrationErrorResponse, requireIntegrationAuth } from "@/lib/integrationAuth";

export async function GET(request: Request) {
  try {
    const { organizationId } = requireIntegrationAuth(request);
    const url = new URL(request.url);
    const branchCode = String(url.searchParams.get("branch") ?? "MAIN").trim().toUpperCase();
    const date = String(url.searchParams.get("date") ?? "");
    const summary = await getDailyOperationsSummary({ organizationId, branchCode, date });
    return Response.json(summary);
  } catch (error) {
    return integrationErrorResponse(error);
  }
}
