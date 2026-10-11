import { afterEach, describe, expect, it } from "vitest";
import { GET as getEvents } from "@/app/api/integrations/n8n/events/route";
import { POST as acknowledgeEvent } from "@/app/api/integrations/n8n/events/[id]/ack/route";
import { prisma } from "@/lib/prisma";
import { cleanupFixture, createFixture } from "./testFixture";

describe("n8n integration routes", () => {
  const originalToken = process.env.N8N_INTEGRATION_TOKEN;
  const originalOrganizationId = process.env.N8N_ORGANIZATION_ID;
  const orgIds: string[] = [];

  afterEach(async () => {
    for (const orgId of orgIds.splice(0)) await cleanupFixture(orgId);
    if (originalToken === undefined) delete process.env.N8N_INTEGRATION_TOKEN;
    else process.env.N8N_INTEGRATION_TOKEN = originalToken;
    if (originalOrganizationId === undefined) delete process.env.N8N_ORGANIZATION_ID;
    else process.env.N8N_ORGANIZATION_ID = originalOrganizationId;
  });

  it("rejects bad tokens, filters by pilot branch, and conceals cross-organization events", async () => {
    const first = await createFixture();
    const second = await createFixture();
    orgIds.push(first.org.id, second.org.id);
    process.env.N8N_INTEGRATION_TOKEN = "route-secret";
    process.env.N8N_ORGANIZATION_ID = first.org.id;

    const firstEvent = await prisma.integrationEvent.create({
      data: {
        organizationId: first.org.id,
        branchId: first.branchA.id,
        type: "INVENTORY_LOW",
        severity: "WARNING",
        dedupeKey: `route-test:${first.org.id}`,
        payload: { ingredientName: "Test Ingredient" },
      },
    });
    const crossOrgEvent = await prisma.integrationEvent.create({
      data: {
        organizationId: second.org.id,
        branchId: second.branchA.id,
        type: "INVENTORY_LOW",
        severity: "WARNING",
        dedupeKey: `route-test:${second.org.id}`,
        payload: { ingredientName: "Other Ingredient" },
      },
    });

    const unauthorized = await getEvents(new Request("http://localhost/api/integrations/n8n/events", {
      headers: { Authorization: "Bearer wrong" },
    }));
    expect(unauthorized.status).toBe(401);

    const authorized = await getEvents(new Request(
      "http://localhost/api/integrations/n8n/events?branch=A",
      { headers: { Authorization: "Bearer route-secret" } },
    ));
    expect(authorized.status).toBe(200);
    const body = await authorized.json() as { events: { id: string }[] };
    expect(body.events.map((event) => event.id)).toEqual([firstEvent.id]);

    const crossOrgAck = await acknowledgeEvent(new Request(
      `http://localhost/api/integrations/n8n/events/${crossOrgEvent.id}/ack`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer route-secret",
          "Idempotency-Key": "cross-org-attempt",
        },
      },
    ), { params: Promise.resolve({ id: crossOrgEvent.id }) });
    expect(crossOrgAck.status).toBe(404);
  });
});
