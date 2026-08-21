import type { DelegationPlan } from "../../shared/src/index.js";

const parallelIntent =
  /(?<![\p{L}\p{N}_])(parallel(?:ly)?|in parallel|multi[- ]?worker|several\s+(?:workers|agents)|(?:two|three|four|2|3|4)\s+(?:workers|agents)|параллельн[\p{L}\p{N}_]*|нескольк[\p{L}\p{N}_]*\s+(?:воркер|агент)[\p{L}\p{N}_]*|(?:два|три|четыре)\s+(?:воркер|агент)[\p{L}\p{N}_]*)(?![\p{L}\p{N}_])/iu;
const investigationIntent =
  /(?<![\p{L}\p{N}_])(investigat\w*|analy[sz]\w*|research\w*|диагност[\p{L}\p{N}_]*|исслед[\p{L}\p{N}_]*|проанализ[\p{L}\p{N}_]*|разбер[\p{L}\p{N}_]*)(?![\p{L}\p{N}_])/iu;
const domainCue =
  /(?<![\p{L}\p{N}_])(backend|frontend|database|db|git|history|security|performance|latency|logs?|infra|network|api|tests?|бэкенд|фронтенд|баз[\p{L}\p{N}_]*\s+данн[\p{L}\p{N}_]*|истори[\p{L}\p{N}_]*\s+git|безопасност[\p{L}\p{N}_]*|производительност[\p{L}\p{N}_]*|задержк[\p{L}\p{N}_]*|лог[\p{L}\p{N}_]*|инфраструктур[\p{L}\p{N}_]*|тест[\p{L}\p{N}_]*)(?![\p{L}\p{N}_])/giu;

export function shouldPlanParallelDelegation(task: string): boolean {
  const normalized = task.normalize("NFKC");
  if (parallelIntent.test(normalized)) return true;
  const domains = new Set((normalized.match(domainCue) ?? []).map((value) => value.toLocaleLowerCase()));
  return investigationIntent.test(normalized) && domains.size >= 2;
}

export function fallbackParallelDelegationPlan(task: string): DelegationPlan {
  const concise = task.trim().slice(0, 4_000);
  return {
    mode: "parallel",
    workers: [
      {
        title: "Primary investigation",
        role: "primary investigator",
        task: `${concise}\n\nEstablish the primary evidence, root causes, and concrete findings.`,
      },
      {
        title: "Independent verification",
        role: "independent verifier",
        task: `${concise}\n\nIndependently test the leading hypotheses and look for contradictory evidence.`,
      },
      {
        title: "Risks and validation",
        role: "risk and validation reviewer",
        task: `${concise}\n\nFocus on regressions, edge cases, validation strategy, and important evidence the other investigations may miss.`,
      },
    ],
    synthesisGoal: `Synthesize a single evidence-backed answer for: ${concise.slice(0, 500)}`,
    rationale: "Parallel work was explicitly requested or the investigation spans multiple independent domains.",
  };
}

export function parseDelegationPlan(value: string): DelegationPlan | undefined {
  const parsed = parseJsonObject(value);
  if (!parsed || parsed.mode !== "parallel" || !Array.isArray(parsed.workers)) return undefined;
  const workers = parsed.workers.flatMap((candidate) => {
    if (
      !isRecord(candidate) ||
      typeof candidate.title !== "string" ||
      typeof candidate.task !== "string" ||
      typeof candidate.role !== "string"
    ) {
      return [];
    }
    const title = candidate.title.trim().slice(0, 100);
    const task = candidate.task.trim().slice(0, 8_000);
    const role = candidate.role.trim().slice(0, 100);
    return title && task && role ? [{ title, task, role }] : [];
  });
  const uniqueWorkers = workers.filter((worker, index, all) => {
    const signature = worker.task.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ");
    return all.findIndex(
      (candidate) =>
        candidate.task.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ") === signature,
    ) === index;
  });
  if (uniqueWorkers.length < 2) return undefined;
  return {
    mode: "parallel",
    workers: uniqueWorkers.slice(0, 4),
    synthesisGoal:
      typeof parsed.synthesisGoal === "string" && parsed.synthesisGoal.trim()
        ? parsed.synthesisGoal.trim().slice(0, 2_000)
        : "Synthesize the worker findings into one concise, evidence-backed answer.",
    rationale:
      typeof parsed.rationale === "string" && parsed.rationale.trim()
        ? parsed.rationale.trim().slice(0, 1_000)
        : "Operator selected parallel investigation.",
  };
}

function parseJsonObject(value: string): Record<string, unknown> | undefined {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/iu.exec(value)?.[1];
  const candidate = fenced ?? value.slice(value.indexOf("{"), value.lastIndexOf("}") + 1);
  if (!candidate) return undefined;
  try {
    const parsed: unknown = JSON.parse(candidate);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
