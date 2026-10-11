import { afterEach, describe, expect, it } from "vitest";
import {
  IntegrationAuthError,
  requireIdempotencyKey,
  requireIntegrationAuth,
  runIdempotentMutation,
} from "@/lib/integrationAuth";
import { cleanupFixture, createFixture } from "./testFixture";

describe("n8n integration authentication and idempotency", () => {
  const originalToken = process.env.N8N_INTEGRATION_TOKEN;
  const originalOrganizationId = process.env.N8N_ORGANIZATION_ID;
  let orgId: string | null = null;

  afterEach(async () => {
    if (orgId) await cleanupFixture(orgId);
    orgId = null;
    if (originalToken === undefined) delete process.env.N8N_INTEGRATION_TOKEN;
    else process.env.N8N_INTEGRATION_TOKEN = originalToken;
    if (originalOrganizationId === undefined) delete process.env.N8N_ORGANIZATION_ID;
    else process.env.N8N_ORGANIZATION_ID = originalOrganizationId;
  });

  it("rejects an invalid bearer token and ignores caller-supplied organization scope", () => {
    process.env.N8N_INTEGRATION_TOKEN = "expected-secret";
    process.env.N8N_ORGANIZATION_ID = "trusted-org";
    expect(() => requireIntegrationAuth(new Request("http://localhost", {
      headers: { Authorization: "Bearer wrong-secret" },
    }))).toThrow(IntegrationAuthError);

    const result = requireIntegrationAuth(new Request("http://localhost", {
      headers: {
        Authorization: "Bearer expected-secret",
        "x-organization-id": "attacker-selected-org",
      },
    }));
    expect(result.organizationId).toBe("trusted-org");
  });

  it("requires a bounded idempotency key", () => {
    expect(() => requireIdempotencyKey(new Request("http://localhost"))).toThrow(IntegrationAuthError);
    expect(requireIdempotencyKey(new Request("http://localhost", {
      headers: { "Idempotency-Key": "operation-123" },
    }))).toBe("operation-123");
  });

  it("replays the stored response without executing the mutation twice", async () => {
    const { org } = await createFixture();
    orgId = org.id;
    let executions = 0;
    const invoke = () => runIdempotentMutation({
      organizationId: org.id,
      operation: "test.operation",
      idempotencyKey: "same-request",
      run: async () => {
        executions += 1;
        return { draftId: "draft-1" };
      },
    });

    const first = await invoke();
    const second = await invoke();
    expect(first).toEqual({ response: { draftId: "draft-1" }, replayed: false });
    expect(second).toEqual({ response: { draftId: "draft-1" }, replayed: true });
    expect(executions).toBe(1);
  });
});
