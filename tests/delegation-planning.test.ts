import { describe, expect, it } from "vitest";
import { parseDelegationPlan, singleDelegationPlan } from "../packages/policy/src/delegation-planning.js";

describe("delegation planning", () => {
  it("accepts an explicit single-worker plan", () => {
    const plan = parseDelegationPlan('{"mode":"single","rationale":"One file write."}');
    expect(plan?.mode).toBe("single");
    expect(plan?.workers).toHaveLength(0);
    expect(plan?.rationale).toBe("One file write.");
  });

  it("keeps every distinct scope the Operator asked for", () => {
    const plan = parseDelegationPlan(
      JSON.stringify({
        mode: "parallel",
        workers: [
          { title: "Backend", role: "backend", task: "Profile backend." },
          { title: "Database", role: "database", task: "Analyze queries." },
          { title: "History", role: "history", task: "Inspect git history." },
          { title: "Tests", role: "tests", task: "Run regressions." },
          { title: "Fifth", role: "extra", task: "Check the cache layer." },
        ],
        synthesisGoal: "Explain latency.",
        rationale: "Independent evidence.",
      }),
    );
    expect(plan?.mode).toBe("parallel");
    expect(plan?.workers).toHaveLength(5);
  });

  it("rejects malformed plans and collapses degenerate fan-outs to single", () => {
    expect(parseDelegationPlan("not json at all")).toBeUndefined();
    expect(parseDelegationPlan('{"mode":"swarm","workers":[]}')).toBeUndefined();
    expect(parseDelegationPlan('{"mode":"parallel","workers":[{"title":"one"}]}')?.mode).toBe("single");
    expect(
      parseDelegationPlan(
        JSON.stringify({
          mode: "parallel",
          workers: [
            { title: "One", role: "a", task: "Inspect the backend." },
            { title: "Duplicate", role: "b", task: "  inspect   the BACKEND. " },
          ],
        }),
      )?.mode,
    ).toBe("single");
  });

  it("provides a single-worker default", () => {
    expect(singleDelegationPlan().mode).toBe("single");
    expect(singleDelegationPlan("planner down").rationale).toBe("planner down");
  });
});
