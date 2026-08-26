import type { FocusState, Project } from "../../shared/src/index.js";
import { nowIso } from "../../shared/src/index.js";

// Routing is the Operator's job: the agent reads the message envelope and uses
// the t3.* tools to find, continue, or create work threads. Only mechanical
// facts stay in code — cancel intent, explicit project references for
// commands, and durable focus bookkeeping.

const cancelWords = new Set(["стоп", "отмена", "отмени", "хватит", "cancel", "stop"]);

/**
 * A cancel intent is a short standalone phrase (≤3 words) that starts with a
 * cancel word — «стоп», «хватит, спасибо», "stop it please". A sentence that
 * merely begins with one ("stop doing X when the tests pass") is an
 * instruction, not an interrupt, and must not kill running work (bug №1).
 *
 * Package 4.3 review: punctuation is stripped from BOTH ends of the first word,
 * so the slash forms count too. Package 1.3 deleted `/stop` and `/cancel` as
 * commands, and until this fix they were the one spelling of a panic that
 * bought a full LLM turn instead of the deterministic hatch — the worst
 * possible outcome for the one phrase a user types when something is wrong.
 * «/focus clear» is unaffected: it is not a cancel word and still reaches the
 * agent as ordinary text.
 */
export function isCancelIntent(text: string): boolean {
  const words = text.normalize("NFKC").trim().split(/\s+/u).filter(Boolean);
  if (words.length === 0 || words.length > 3) return false;
  const first = words[0]!
    .toLocaleLowerCase()
    .replace(/^[^\p{L}\p{N}_]+/u, "")
    .replace(/[^\p{L}\p{N}_]+$/u, "");
  return cancelWords.has(first);
}

/**
 * Match an explicit project mention by name or alias. Matches only on word
 * boundaries so a project named "AI" cannot hijack the word "email".
 */
export function resolveProjectReference(text: string, projects: Project[]): Project | undefined {
  const lowered = text.normalize("NFKC").toLocaleLowerCase();
  const isWordChar = (char: string | undefined) =>
    char !== undefined && /[\p{L}\p{N}_]/u.test(char);
  let best: { project: Project; length: number } | undefined;
  for (const project of projects) {
    for (const raw of [project.name, ...(project.aliases ?? [])]) {
      const needle = raw.normalize("NFKC").toLocaleLowerCase().trim();
      if (needle.length < 2) continue;
      let index = lowered.indexOf(needle);
      while (index !== -1) {
        if (!isWordChar(lowered[index - 1]) && !isWordChar(lowered[index + needle.length])) {
          if (!best || needle.length > best.length) best = { project, length: needle.length };
          break;
        }
        index = lowered.indexOf(needle, index + 1);
      }
    }
  }
  return best?.project;
}

export interface FocusTarget {
  projectId: string;
  threadId?: string;
}

/** Push the previous primary focus onto the bounded secondary stack. */
export function updateFocus(
  current: FocusState,
  target: FocusTarget,
  topic: string,
  confidence: number,
): FocusState {
  const previous = current.primary;
  const secondary = [...current.secondary];
  if (previous && (previous.projectId !== target.projectId || previous.threadId !== target.threadId)) {
    secondary.unshift({
      projectId: previous.projectId,
      ...(previous.threadId ? { threadId: previous.threadId } : {}),
      topic: previous.topic,
      updatedAt: previous.updatedAt,
    });
  }
  return {
    primary: {
      projectId: target.projectId,
      ...(target.threadId ? { threadId: target.threadId } : {}),
      topic: topic.slice(0, 160),
      confidence,
      updatedAt: nowIso(),
    },
    secondary: secondary
      .filter(
        (item, index, all) =>
          all.findIndex(
            (candidate) => candidate.projectId === item.projectId && candidate.threadId === item.threadId,
          ) === index,
      )
      .slice(0, 6),
  };
}
