import { describe, expect, it } from "vitest";
import { selectWorkerModel } from "../packages/policy/src/index.js";
import type { ProviderDescriptor } from "../packages/shared/src/index.js";

describe("worker provider/model policy", () => {
  const providers: ProviderDescriptor[] = [provider("claude_work", "claudeAgent", [
    model("claude-sonnet-5", "Claude Sonnet 5"),
    model("claude-opus-5", "Claude Opus 5", true),
    model("claude-fable-1", "Claude Fable 1"),
  ])];

  it.each([
    ["rename the typo and format the file", "claude-sonnet-5", "high", "mechanical"],
    ["implement the auth refresh flow", "claude-opus-5", "high", "ordinary"],
    ["design a complex distributed migration architecture", "claude-fable-1", "medium", "complex"],
  ] as const)("selects the simple three-tier default for %s", (task, expectedModel, effort, complexity) => {
    const selected = selectWorkerModel({
      task,
      providers,
      defaultProviderInstanceId: "claude_work",
      defaultModel: "claude-opus-5",
    });
    expect(selected).toMatchObject({ model: expectedModel, complexity, explicit: false });
    expect(selected.modelOptions).toEqual([{ id: "effort", value: effort }]);
  });

  it("gives explicit model and reasoning requests priority", () => {
    const selected = selectWorkerModel({
      task: "Use Sonnet with maximum reasoning to implement this",
      providers,
      defaultProviderInstanceId: "claude_work",
      defaultModel: "claude-opus-5",
    });
    expect(selected).toMatchObject({ model: "claude-sonnet-5", explicit: true });
    expect(selected.modelOptions).toEqual([{ id: "effort", value: "max" }]);
  });

  it("optimizes non-explicit selection from observed latency, reliability, and configured cost", () => {
    const alternatives = [
      ...providers,
      provider("fast_provider", "otherDriver", [model("fast-opus", "Fast Opus", true)]),
    ];
    const selected = selectWorkerModel({
      task: "implement the auth refresh flow",
      providers: alternatives,
      defaultProviderInstanceId: "claude_work",
      defaultModel: "claude-opus-5",
      performance: [
        { providerInstanceId: "claude_work", model: "claude-opus-5", samples: 10, successes: 7, failures: 3, averageLatencyMs: 80_000, estimatedCostUsd: 2, updatedAt: new Date().toISOString() },
        { providerInstanceId: "fast_provider", model: "fast-opus", samples: 10, successes: 10, failures: 0, averageLatencyMs: 20_000, estimatedCostUsd: 0.5, updatedAt: new Date().toISOString() },
      ],
      estimatedCostsUsd: { "claude_work/claude-opus-5": 0.2, "fast_provider/fast-opus": 0.05 },
      optimization: { enabled: true, costWeight: 0.35, latencyWeight: 0.35, reliabilityWeight: 0.3 },
    });
    expect(selected).toMatchObject({ providerInstanceId: "fast_provider", model: "fast-opus", estimatedCostUsd: 0.05 });
    expect(selected.rationale).toContain("Cost/latency policy selected");

    const explicit = selectWorkerModel({
      task: "Use claude-opus-5 for this implementation",
      providers: alternatives,
      defaultProviderInstanceId: "claude_work",
      defaultModel: "claude-opus-5",
      performance: [],
      estimatedCostsUsd: { "claude_work/claude-opus-5": 0.2, "fast_provider/fast-opus": 0.05 },
      optimization: { enabled: true, costWeight: 1, latencyWeight: 0, reliabilityWeight: 0 },
    });
    expect(explicit).toMatchObject({ providerInstanceId: "claude_work", model: "claude-opus-5", explicit: true });
  });
});

function provider(instanceId: string, driver: string, models: ProviderDescriptor["models"]): ProviderDescriptor {
  return {
    instanceId,
    driver,
    displayName: "Claude Work",
    enabled: true,
    installed: true,
    available: true,
    ready: true,
    authenticated: true,
    requiresNewThreadForModelChange: false,
    showInteractionModeToggle: false,
    capabilities: {
      liveInput: true,
      interrupt: true,
      approvals: true,
      resume: true,
      cwdSwitch: false,
      structuredEvents: true,
      toolEvents: true,
    },
    models,
  };
}

function model(slug: string, name: string, isDefault = false): ProviderDescriptor["models"][number] {
  return {
    slug,
    name,
    isDefault,
    capabilities: [
      {
        id: "effort",
        label: "Reasoning effort",
        type: "select",
        choices: [
          { id: "medium", label: "Medium" },
          { id: "high", label: "High", isDefault: true },
          { id: "max", label: "Max" },
        ],
      },
    ],
  };
}
