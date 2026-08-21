import type { ProviderDescriptor } from "../../shared/src/index.js";

export type TaskComplexity = "mechanical" | "ordinary" | "complex";

export interface WorkerModelSelection {
  providerInstanceId: string;
  model: string;
  modelOptions: Array<{ id: string; value: string | boolean }>;
  complexity: TaskComplexity;
  explicit: boolean;
  rationale: string;
}

export function selectWorkerModel(input: {
  task: string;
  providers: ProviderDescriptor[];
  defaultProviderInstanceId: string;
  defaultModel: string;
}): WorkerModelSelection {
  const task = input.task.normalize("NFKC").toLocaleLowerCase();
  const operational = input.providers.filter(
    (provider) =>
      provider.available &&
      provider.enabled &&
      provider.installed &&
      provider.ready &&
      provider.authenticated !== false,
  );
  const explicitProvider = operational.find((provider) => providerMentioned(task, provider));
  const modelMatches = (explicitProvider ? [explicitProvider] : operational).flatMap((provider) =>
    provider.models
      .filter((model) => modelMentioned(task, model.slug, model.name, model.shortName))
      .map((model) => ({ provider, model })),
  );
  const explicitModel = modelMatches.sort(
    (left, right) => right.model.slug.length - left.model.slug.length,
  )[0];
  const provider =
    explicitModel?.provider ??
    explicitProvider ??
    operational.find((candidate) => candidate.instanceId === input.defaultProviderInstanceId) ??
    operational[0];
  const complexity = classifyTaskComplexity(task);
  const desiredFamily =
    complexity === "mechanical" ? "sonnet" : complexity === "complex" ? "fable" : "opus";
  const model =
    explicitModel?.model ??
    provider?.models.find((candidate) => modelHasFamily(candidate.slug, candidate.name, desiredFamily)) ??
    provider?.models.find((candidate) => candidate.slug === input.defaultModel) ??
    provider?.models.find((candidate) => candidate.isDefault) ??
    provider?.models[0];
  const explicitEffort = parseExplicitEffort(task);
  const desiredEffort = explicitEffort ?? (complexity === "complex" ? "medium" : "high");

  if (!provider || !model) {
    return {
      providerInstanceId: input.defaultProviderInstanceId,
      model: input.defaultModel,
      modelOptions: [],
      complexity,
      explicit: Boolean(explicitProvider || explicitModel || explicitEffort),
      rationale: "T3 did not advertise an operational provider catalog; using configured defaults.",
    };
  }

  const effortDescriptor = model.capabilities.find(
    (descriptor) =>
      descriptor.type === "select" &&
      (/effort|reason/i.test(descriptor.id) || /effort|reason/i.test(descriptor.label)),
  );
  const effortChoice =
    effortDescriptor?.choices?.find(
      (choice) =>
        choice.id.toLocaleLowerCase() === desiredEffort ||
        choice.label.toLocaleLowerCase() === desiredEffort,
    ) ?? effortDescriptor?.choices?.find((choice) => choice.isDefault);
  return {
    providerInstanceId: provider.instanceId,
    model: model.slug,
    modelOptions:
      effortDescriptor && effortChoice ? [{ id: effortDescriptor.id, value: effortChoice.id }] : [],
    complexity,
    explicit: Boolean(explicitProvider || explicitModel || explicitEffort),
    rationale: explicitModel
      ? `User explicitly selected ${model.name}.`
      : explicitProvider
        ? `User explicitly selected ${provider.displayName}; ${model.name} follows task policy.`
        : `${complexity} task policy selected ${model.name} with ${desiredEffort} reasoning when available.`,
  };
}

export function classifyTaskComplexity(normalizedTask: string): TaskComplexity {
  if (
    /\b(typo|rename|format|lint|mechanical|boilerplate|прост(?:ая|ой|ое)?|механическ|опечатк|переимен|форматир)\b/iu.test(
      normalizedTask,
    )
  ) {
    return "mechanical";
  }
  if (
    /\b(architecture|architect|migration|distributed|security audit|deep research|redesign|сложн|архитект|миграц|исследован|безопасност)\b/iu.test(
      normalizedTask,
    ) || normalizedTask.length > 1_500
  ) {
    return "complex";
  }
  return "ordinary";
}

function providerMentioned(task: string, provider: ProviderDescriptor): boolean {
  return [provider.instanceId, provider.driver, provider.displayName].some((name) =>
    containsPhrase(task, name),
  );
}

function modelMentioned(task: string, slug: string, name: string, shortName?: string): boolean {
  if ([slug, name, shortName].filter(Boolean).some((value) => containsPhrase(task, value!))) return true;
  for (const family of ["opus", "sonnet", "fable", "haiku", "codex", "gpt", "composer"]) {
    if (modelHasFamily(slug, name, family) && new RegExp(`(?:^|\\W)${family}(?:$|\\W)`, "iu").test(task)) {
      return true;
    }
  }
  return false;
}

function modelHasFamily(slug: string, name: string, family: string): boolean {
  return `${slug} ${name}`.toLocaleLowerCase().includes(family);
}

function containsPhrase(task: string, value: string): boolean {
  const normalized = value.normalize("NFKC").trim().toLocaleLowerCase();
  return normalized.length >= 3 && task.includes(normalized);
}

function parseExplicitEffort(task: string): "low" | "medium" | "high" | "xhigh" | "max" | undefined {
  if (/(?:max(?:imum)?|максимальн\w*)\s+(?:reasoning|effort|рассужден)/iu.test(task)) return "max";
  if (/(?:xhigh|extra[- ]?high)\s+(?:reasoning|effort)/iu.test(task)) return "xhigh";
  if (/(?:high|высок\w*)\s+(?:reasoning|effort|рассужден)/iu.test(task)) return "high";
  if (/(?:medium|средн\w*)\s+(?:reasoning|effort|рассужден)/iu.test(task)) return "medium";
  if (/(?:low|низк\w*)\s+(?:reasoning|effort|рассужден)/iu.test(task)) return "low";
  return undefined;
}
