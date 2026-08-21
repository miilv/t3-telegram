import pino from "pino";
import { describe, expect, it } from "vitest";
import { DashboardServer } from "../packages/dashboard/src/index.js";
import type { OperatorPolicySettings } from "../packages/shared/src/index.js";
import { tempStore } from "./helpers.js";

describe("DashboardServer", () => {
  it("serves a loopback capability-protected dashboard and validates policy writes", async () => {
    const store = tempStore();
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
      health: async () => ({ telegram: true, t3: true, operator: true, database: true }),
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
      expect(await stateResponse.json()).toMatchObject({
        health: { telegram: true, t3: true },
        policy: { maxParallelWorkers: 4 },
      });
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
