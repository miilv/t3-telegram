import { describe, expect, it } from "vitest";
import {
  fallbackParallelDelegationPlan,
  parseDelegationPlan,
  shouldPlanParallelDelegation,
} from "../packages/policy/src/delegation-planning.js";

describe("parallel delegation policy", () => {
  it("detects explicit fan-out and multi-domain investigations", () => {
    expect(shouldPlanParallelDelegation("use three workers in parallel")).toBe(true);
    expect(shouldPlanParallelDelegation("запусти три воркера параллельно")).toBe(true);
    expect(
      shouldPlanParallelDelegation("investigate production latency across backend, database, and logs"),
    ).toBe(true);
    expect(shouldPlanParallelDelegation("fix this typo")).toBe(false);
  });

  it("strictly parses and bounds an Operator plan", () => {
    const plan = parseDelegationPlan(
      JSON.stringify({
        mode: "parallel",
        workers: [
          { title: "Backend", role: "backend", task: "Profile backend." },
          { title: "Database", role: "database", task: "Analyze queries." },
          { title: "History", role: "history", task: "Inspect git history." },
          { title: "Tests", role: "tests", task: "Run regressions." },
          { title: "Ignored", role: "extra", task: "This fifth scope is bounded out." },
        ],
        synthesisGoal: "Explain latency.",
        rationale: "Independent evidence.",
      }),
    );
    expect(plan?.workers).toHaveLength(4);
    expect(parseDelegationPlan('{"mode":"parallel","workers":[{"title":"one"}]}')).toBeUndefined();
    expect(
      parseDelegationPlan(
        JSON.stringify({
          mode: "parallel",
          workers: [
            { title: "One", role: "a", task: "Inspect the backend." },
            { title: "Duplicate", role: "b", task: "  inspect   the BACKEND. " },
          ],
        }),
      ),
    ).toBeUndefined();
  });

  it("provides three non-duplicate deterministic fallback scopes", () => {
    const plan = fallbackParallelDelegationPlan("Investigate latency");
    expect(plan.workers).toHaveLength(3);
    expect(new Set(plan.workers.map((worker) => worker.role)).size).toBe(3);
  });
});
