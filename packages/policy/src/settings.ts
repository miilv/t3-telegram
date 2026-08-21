import { z } from "zod";
import type { OperatorPolicySettings } from "../../shared/src/index.js";
import type { OperatorStore } from "../../storage/src/index.js";

const policySchema = z.object({
  approvalAutoAllow: z.array(z.enum([
    "safe-read",
    "safe-write-in-project",
    "network",
    "package-install",
    "process-control",
    "destructive",
    "cross-project",
    "secret-sensitive",
  ])).max(8),
  maxParallelWorkers: z.number().int().min(2).max(4),
  progressIntervalMs: z.number().int().min(5_000).max(600_000),
  providerOptimizationEnabled: z.boolean(),
  providerCostWeight: z.number().min(0).max(1),
  providerLatencyWeight: z.number().min(0).max(1),
  providerReliabilityWeight: z.number().min(0).max(1),
}).refine(
  (value) => value.providerCostWeight + value.providerLatencyWeight + value.providerReliabilityWeight > 0,
  { message: "at least one provider optimization weight must be positive" },
);

export function readOperatorPolicy(
  store: OperatorStore,
  defaults: OperatorPolicySettings,
): OperatorPolicySettings {
  return policySchema.parse({
    ...defaults,
    ...(store.getPolicySetting<Partial<OperatorPolicySettings>>("settings") ?? {}),
  });
}

export function updateOperatorPolicy(
  store: OperatorStore,
  defaults: OperatorPolicySettings,
  patch: Partial<OperatorPolicySettings>,
  updatedBy: string,
): OperatorPolicySettings {
  const next = policySchema.parse({ ...readOperatorPolicy(store, defaults), ...patch });
  store.setPolicySetting("settings", next, updatedBy);
  return next;
}
