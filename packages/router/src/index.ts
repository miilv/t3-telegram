import { execFileSync } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  ArtifactRef,
  FocusState,
  Project,
  RoutingDecision,
  ThreadCandidate,
  WorkBinding,
} from "../../shared/src/index.js";
import { nowIso, unique } from "../../shared/src/index.js";
import type { OperatorStore } from "../../storage/src/index.js";

const followUpPattern =
  /^(продолжай|готово\??|что там\??|а тесты\??|пусть исправит|сделай это|дальше|ещ[её]|также|добавь|continue|also|and also|status\??|done\??|what's up\??)/iu;
const cancelPattern = /^(?:стоп|отмени|хватит|cancel|stop)(?=$|[^\p{L}\p{N}_])/iu;
const handoffPattern =
  /(?:^|[^\p{L}\p{N}_])(перенеси|перенести|перемести|переведи\s+(?:работу|задачу)|move\s+(?:this|the\s+work|task)|transfer\s+(?:this|the\s+work|task)|handoff)(?=$|[^\p{L}\p{N}_])/iu;
const sideQuestionPattern =
  /^(который час|сколько времени|столица|переведи|что значит|посчитай|what time|capital of|translate|calculate)\b/iu;

export interface RouteInput {
  text: string;
  replyThreadId?: string;
  artifacts: ArtifactRef[];
  focus: FocusState;
  projects: Project[];
  threadCandidates?: ThreadCandidate[];
}

export class RoutingEngine {
  constructor(private readonly store?: OperatorStore) {}

  route(input: RouteInput): RoutingDecision {
    const text = input.text.trim();
    const lowered = text.toLocaleLowerCase();

    const explicitProject = bestNamedProject(lowered, input.projects);
    if (explicitProject) {
      const thread = input.threadCandidates?.find(
        (candidate) => candidate.thread.projectId === explicitProject.id && candidate.score >= 0.78,
      );
      return thread
        ? decision({ type: "thread", threadId: thread.thread.id }, 0.93, ["explicit project name", ...thread.reasons])
        : decision({ type: "project", projectId: explicitProject.id }, 0.92, ["explicit project name"]);
    }

    if (input.replyThreadId) {
      return decision({ type: "thread", threadId: input.replyThreadId }, 0.99, ["Telegram reply mapping"]);
    }

    const artifactThreads = unique(
      input.artifacts.map((artifact) => artifact.threadId).filter((id): id is string => Boolean(id)),
    );
    if (artifactThreads.length === 1) {
      return decision({ type: "thread", threadId: artifactThreads[0]! }, 0.97, ["artifact provenance"]);
    }
    if (artifactThreads.length > 1) {
      return decision(
        { type: "multi_thread", primaryThreadId: artifactThreads[0]!, threadIds: artifactThreads },
        0.94,
        ["multiple artifact provenance links"],
      );
    }

    const pathProject = projectFromPath(text, input.projects);
    if (pathProject) {
      return decision({ type: "project", projectId: pathProject.id }, 0.97, ["filesystem workspace match"]);
    }

    if (!sideQuestionPattern.test(lowered) && (followUpPattern.test(lowered) || cancelPattern.test(lowered))) {
      if (input.focus.primary?.threadId) {
        return decision(
          { type: "thread", threadId: input.focus.primary.threadId },
          0.92,
          ["active focus follow-up"],
        );
      }
      if (input.focus.primary) {
        return decision({ type: "project", projectId: input.focus.primary.projectId }, 0.84, ["active project focus"]);
      }
    }

    const bestThread = input.threadCandidates?.[0];
    const secondThread = input.threadCandidates?.[1];
    if (
      bestThread &&
      secondThread &&
      bestThread.thread.id !== secondThread.thread.id &&
      bestThread.score >= 0.78 &&
      secondThread.score >= 0.76 &&
      bestThread.score - secondThread.score < 0.08
    ) {
      return {
        binding: {
          type: "multi_thread",
          threadIds: [bestThread.thread.id, secondThread.thread.id],
        },
        confidence: 0.65,
        reasons: ["two materially similar thread candidates"],
        shouldAsk: true,
      };
    }
    if (bestThread && bestThread.score >= 0.78) {
      return decision({ type: "thread", threadId: bestThread.thread.id }, bestThread.score, bestThread.reasons);
    }

    if (bestThread && bestThread.score >= 0.7) {
      return {
        binding: { type: "thread", threadId: bestThread.thread.id },
        confidence: bestThread.score,
        reasons: bestThread.reasons,
        shouldAsk: false,
      };
    }

    return decision({ type: "none" }, 0.5, ["no durable work binding"]);
  }

  searchCandidates(text: string, projectId?: string): ThreadCandidate[] {
    return this.store?.searchThreads(text, projectId, 8) ?? [];
  }

  updateFocus(current: FocusState, binding: WorkBinding, topic: string, confidence: number): FocusState {
    if (binding.type === "none") return current;
    const projectId =
      binding.type === "project"
        ? binding.projectId
        : binding.type === "thread"
          ? this.store?.getThread(binding.threadId)?.projectId
          : binding.primaryThreadId
            ? this.store?.getThread(binding.primaryThreadId)?.projectId
            : undefined;
    const threadId =
      binding.type === "thread"
        ? binding.threadId
        : binding.type === "multi_thread"
          ? binding.primaryThreadId
          : undefined;
    if (!projectId) return current;
    const previous = current.primary;
    const secondary = [...current.secondary];
    if (previous && (previous.projectId !== projectId || previous.threadId !== threadId)) {
      secondary.unshift({
        projectId: previous.projectId,
        ...(previous.threadId ? { threadId: previous.threadId } : {}),
        topic: previous.topic,
        updatedAt: previous.updatedAt,
      });
    }
    return {
      primary: {
        projectId,
        ...(threadId ? { threadId } : {}),
        topic: topic.slice(0, 160),
        confidence,
        updatedAt: nowIso(),
      },
      secondary: secondary
        .filter((item, index, all) =>
          all.findIndex((candidate) => candidate.projectId === item.projectId && candidate.threadId === item.threadId) === index,
        )
        .slice(0, 6),
    };
  }
}

export function shouldDelegate(text: string, artifacts: ArtifactRef[], binding: WorkBinding): boolean {
  const normalized = text.toLocaleLowerCase();
  if (binding.type === "thread" || binding.type === "multi_thread") return true;
  if (artifacts.length > 0) return true;
  if (/(?:^|\s)(fix|implement|build|debug|test|review|investigate|analy[sz]e|refactor|deploy|исправ|реализ|собер|отлад|протест|проверь код|разберись|проанализ)[\p{L}\p{N}_-]*/iu.test(normalized)) {
    return true;
  }
  if (extractPaths(text).length > 0) return true;
  if (text.length > 700) return true;
  return false;
}

export function isCancelIntent(text: string): boolean {
  return cancelPattern.test(text.trim());
}

export function isHandoffIntent(text: string): boolean {
  return handoffPattern.test(text.trim());
}

export function resolveProjectReference(text: string, projects: Project[]): Project | undefined {
  return bestNamedProject(text.toLocaleLowerCase(), projects) ?? projectFromPath(text, projects);
}

export function semanticProjectName(text: string): string {
  const cleaned = text
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(
      (word) =>
        word.length > 2 &&
        !/^(please|нужно|сделай|разберись|исправь|проверь|проанализируй|fix|build|implement|investigate|прошу|пожалуйста)$/iu.test(
          word,
        ),
    )
    .slice(0, 6);
  const words = cleaned.length ? cleaned : ["Operator Work"];
  return words.map((word) => word.charAt(0).toLocaleUpperCase() + word.slice(1)).join(" ").slice(0, 72);
}

function decision(binding: WorkBinding, confidence: number, reasons: string[]): RoutingDecision {
  return { binding, confidence, reasons, shouldAsk: confidence < 0.7 };
}

function bestNamedProject(lowered: string, projects: Project[]): Project | undefined {
  return projects
    .map((project) => ({
      project,
      matchedLength: [project.name, ...(project.aliases ?? [])]
        .map((value) => value.toLocaleLowerCase())
        .filter((value) => value.length >= 2 && (lowered.includes(value) || lowered.includes(`проекте ${value}`)))
        .reduce((longest, value) => Math.max(longest, value.length), 0),
    }))
    .filter((entry) => entry.matchedLength > 0)
    .sort((left, right) => right.matchedLength - left.matchedLength)[0]?.project;
}

function projectFromPath(text: string, projects: Project[]): Project | undefined {
  for (const rawPath of extractPaths(text)) {
    const candidate = resolveUserPath(rawPath);
    const candidateRoot = gitRoot(candidate);
    const candidateRemote = candidateRoot ? gitRemote(candidateRoot) : undefined;
    const matches = projects
      .filter((project) => project.workspaceRoot)
      .map((project) => {
        const workspaceRoot = resolveUserPath(project.workspaceRoot!);
        const workspaceGitRoot = gitRoot(workspaceRoot);
        const sameGitRoot = Boolean(candidateRoot && workspaceGitRoot && candidateRoot === workspaceGitRoot);
        const sameRemote = Boolean(
          candidateRemote &&
            workspaceGitRoot &&
            normalizeGitRemote(candidateRemote) === normalizeGitRemote(gitRemote(workspaceGitRoot) ?? ""),
        );
        const distance = sameGitRoot || sameRemote ? 0 : pathDistance(candidate, workspaceRoot);
        return { project, distance };
      })
      .filter((entry) => entry.distance >= 0)
      .sort((a, b) => a.distance - b.distance);
    if (matches[0]) return matches[0].project;
  }
  return undefined;
}

export function extractPaths(text: string): string[] {
  const quoted = [...text.matchAll(/[`"']((?:~\/|\.{1,2}\/|\/)[^`"']+)[`"']/gu)].map(
    (match) => match[1]!,
  );
  const unquoted = text.match(/(?:^|\s)((?:~\/|\.{1,2}\/|\/)[^\s`"',:;]+)/gu) ?? [];
  return unique(
    [...quoted, ...unquoted.map((match) => match.trim())]
      .map((path) => path.replace(/[)\]}]+$/g, ""))
      .filter((path) => isAbsolute(path) || path.startsWith("~/") || path.startsWith("./") || path.startsWith("../")),
  );
}

function pathDistance(candidate: string, root: string): number {
  const rootReal = resolveUserPath(root);
  const rel = relative(rootReal, candidate);
  if (rel === "") return 0;
  if (rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) return -1;
  return rel.split(sep).length;
}

function resolveUserPath(path: string): string {
  const expanded = path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
  if (existsSync(expanded)) return realpathSync(expanded);
  let ancestor = resolve(expanded);
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) return resolve(expanded);
    ancestor = parent;
  }
  const realAncestor = realpathSync(ancestor);
  return resolve(realAncestor, relative(ancestor, resolve(expanded)));
}

function gitRoot(path: string): string | undefined {
  let cursor = path;
  try {
    if (existsSync(cursor) && statSync(cursor).isFile()) cursor = dirname(cursor);
  } catch {
    return undefined;
  }
  while (true) {
    if (existsSync(join(cursor, ".git"))) return cursor;
    const parent = dirname(cursor);
    if (parent === cursor) return undefined;
    cursor = parent;
  }
}

function gitRemote(root: string): string | undefined {
  try {
    return execFileSync("git", ["-C", root, "config", "--get", "remote.origin.url"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1_000,
    }).trim() || undefined;
  } catch {
    return undefined;
  }
}

function normalizeGitRemote(value: string): string {
  return value
    .trim()
    .replace(/^git@([^:]+):/, "https://$1/")
    .replace(/^ssh:\/\/git@/, "https://")
    .replace(/\.git$/i, "")
    .replace(/\/$/, "")
    .toLocaleLowerCase();
}
