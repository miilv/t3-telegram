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
