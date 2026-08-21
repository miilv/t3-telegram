import type { DelegationPlan } from "../../shared/src/index.js";

// Whether a task deserves one worker or several is a judgement call, so the
// Operator makes it: there is no keyword matching and no worker-count heuristic
// here. This module only validates the shape of the plan the Operator returns.

export function singleDelegationPlan(rationale?: string): DelegationPlan {
  return {
    mode: "single",
    workers: [],
    synthesisGoal: "",
    rationale: rationale?.trim().slice(0, 1_000) || "Operator kept the task on one worker.",
  };
}

export function parseDelegationPlan(value: string): DelegationPlan | undefined {
  const parsed = parseJsonObject(value);
  if (!parsed) return undefined;
  if (parsed.mode !== "parallel" && parsed.mode !== "single") return undefined;

  const rationale =
    typeof parsed.rationale === "string" && parsed.rationale.trim()
      ? parsed.rationale.trim().slice(0, 1_000)
      : undefined;

  if (parsed.mode === "single") return singleDelegationPlan(rationale);
  if (!Array.isArray(parsed.workers)) return undefined;

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
    const signature = scopeSignature(worker.task);
    return all.findIndex((candidate) => scopeSignature(candidate.task) === signature) === index;
  });

  // A fan-out of one is a single delegation wearing the wrong label.
  if (uniqueWorkers.length < 2) return singleDelegationPlan(rationale);

  return {
    mode: "parallel",
    workers: uniqueWorkers,
    synthesisGoal:
      typeof parsed.synthesisGoal === "string" && parsed.synthesisGoal.trim()
        ? parsed.synthesisGoal.trim().slice(0, 2_000)
        : "Synthesize the worker findings into one concise, evidence-backed answer.",
    rationale: rationale ?? "Operator selected parallel investigation.",
  };
}

function scopeSignature(task: string): string {
  return task.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ");
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
