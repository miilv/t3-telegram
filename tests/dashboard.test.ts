import pino from "pino";
import { describe, expect, it } from "vitest";
import { DashboardServer } from "../packages/dashboard/src/index.js";
import { createAutomation } from "../packages/automations/src/index.js";
import type { OperatorPolicySettings } from "../packages/shared/src/index.js";
import { tempStore } from "./helpers.js";

describe("DashboardServer", () => {
  it("serves a loopback capability-protected dashboard and validates policy writes", async () => {
    const store = tempStore();
    const automation = createAutomation({
      id: "automation_dashboard_privacy",
      ownerId: "42",
      name: "Deploy token=dashboard-name-secret",
      prompt: "Source prompt api_key=dashboard-source-secret",
      schedule: { type: "interval", intervalMinutes: 60 },
      chatId: 7,
      now: new Date("2026-08-26T10:00:00.000Z"),
    });
    store.saveAutomation(automation);
    expect(store.getAutomation(automation.id)).toMatchObject({
      name: "Deploy token=dashboard-name-secret",
      prompt: "Source prompt api_key=dashboard-source-secret",
    });
    let policy: OperatorPolicySettings = {
      approvalAutoAllow: ["safe-read"],
      maxParallelWorkers: 4,
      progressIntervalMs: 60_000,
      providerOptimizationEnabled: true,
      providerCostWeight: 0.35,
      providerLatencyWeight: 0.35,
      providerReliabilityWeight: 0.3,
    };
    const dashboard = new DashboardServer({
      store,
      logger: pino({ enabled: false }),
      getPolicy: () => policy,
      updatePolicy: (patch) => (policy = { ...policy, ...patch }),
      health: async () => ({
        telegram: true,
        t3: true,
        operator: true,
        database: true,
        nested: { sshKey: "dashboard-private", detail: "token=dashboard-secret" },
      }),
    });
    await dashboard.start();
    try {
      const link = dashboard.link()!;
      const url = new URL(link);
      const token = new URLSearchParams(url.hash.slice(1)).get("token")!;
      url.hash = "";
      const html = await fetch(url).then((response) => response.text());
      expect(html).toContain("Operator cockpit");
      expect(html).toContain("Telegram</div><div class=\"node\">Operator");
      expect((await fetch(new URL("/api/state", url))).status).toBe(401);
      const stateResponse = await fetch(new URL("/api/state", url), {
        headers: { authorization: `Bearer ${token}` },
      });
      const state = await stateResponse.json() as {
        health: Record<string, unknown> & { nested: Record<string, string> };
      };
      expect(state).toMatchObject({
        health: { telegram: true, t3: true },
        policy: { maxParallelWorkers: 4 },
      });
      expect(state.health.nested).toEqual({
        sshKey: "[REDACTED]",
        detail: "token=[REDACTED]",
      });
      expect(state).toMatchObject({
        automations: [{ id: automation.id, name: "Deploy token=[REDACTED]" }],
      });
      expect(JSON.stringify(state)).not.toContain("dashboard-source-secret");
      const updated = await fetch(new URL("/api/policy", url), {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ maxParallelWorkers: 3 }),
      });
      expect(updated.status).toBe(200);
      expect(policy.maxParallelWorkers).toBe(3);
    } finally {
      await dashboard.stop();
      store.close();
    }
  });
});
