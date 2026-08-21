import { mkdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RoutingEngine } from "../packages/router/src/index.js";
import { nowIso, type FocusState, type Project, type WorkThread } from "../packages/shared/src/index.js";
import { tempDirectory } from "./helpers.js";

const timestamp = nowIso();
const emptyFocus: FocusState = { secondary: [] };

describe("routing quality corpus (§89)", () => {
  it("exceeds the explicit reply routing target on representative bilingual turns", () => {
    const messages = [
      "продолжай", "готово?", "что там?", "а тесты?", "пусть исправит",
      "сделай это", "дальше", "ещё", "также добавь тест", "стоп",
      "continue", "also add tests", "status?", "done?", "what's up?",
      "please continue", "ship the fix", "покажи результат", "review that", "one more thing",
    ];
    const router = new RoutingEngine();
    const correct = messages.filter((text, index) => {
      const threadId = `reply-${index}`;
      return bindingKey(router.route({
        text,
        replyThreadId: threadId,
        artifacts: [],
        focus: emptyFocus,
        projects: [],
      }).binding) === `thread:${threadId}`;
    }).length;
    expect(correct / messages.length).toBeGreaterThan(0.95);
  });

  it("exceeds the path/project routing target across names, aliases, and nested paths", () => {
    const roots = Array.from({ length: 10 }, (_, index) => {
      const root = tempDirectory(`routing-corpus-${index}-`);
      mkdirSync(`${root}/src/features/${index}`, { recursive: true });
      return root;
    });
    const projects: Project[] = roots.map((workspaceRoot, index) => ({
      id: `project-${index}`,
      t3ProjectId: `project-${index}`,
      name: `Service ${index} Delta`,
      aliases: [`контур-${index}`, `svc-${index}`],
      workspaceRoot,
      createdAt: timestamp,
      updatedAt: timestamp,
    }));
    const scenarios = [
      ...projects.map((project, index) => ({
        text: index % 2 === 0
          ? `исправь ошибку в ${project.name}`
          : `run tests for ${project.aliases![1]}`,
        expected: `project:${project.id}`,
      })),
      ...projects.map((project, index) => ({
        text: index % 2 === 0
          ? `проверь ${project.workspaceRoot}/src/features/${index}/handler.ts`
          : `review "${project.workspaceRoot}/src/features/${index}/worker file.ts"`,
        expected: `project:${project.id}`,
      })),
    ];
    const router = new RoutingEngine();
    const correct = scenarios.filter(({ text, expected }) =>
      bindingKey(router.route({ text, artifacts: [], focus: emptyFocus, projects }).binding) === expected,
    ).length;
    expect(correct / scenarios.length).toBeGreaterThan(0.95);
  });

  it("exceeds the obvious-focus follow-up target without losing focus on side questions", () => {
    const focus: FocusState = {
      primary: {
        projectId: "acme",
        threadId: "auth-refresh",
        topic: "repair refresh-token locking",
        confidence: 0.97,
        updatedAt: timestamp,
      },
      secondary: [],
    };
    const followUps = [
      "продолжай", "готово?", "что там?", "а тесты?", "пусть исправит",
      "сделай это", "дальше", "ещё проверь логи", "также добавь тест", "добавь метрики",
      "continue", "also test retries", "and also document it", "status?", "done?",
      "what's up?", "cancel", "stop", "отмени", "хватит",
    ];
    const router = new RoutingEngine();
    const correct = followUps.filter((text) =>
      bindingKey(router.route({ text, artifacts: [], focus, projects: [] }).binding)
        === "thread:auth-refresh",
    ).length;
    expect(correct / followUps.length).toBeGreaterThan(0.9);

    const sideQuestions = [
      "который час в Токио?", "сколько времени в Берлине?", "столица Франции?",
      "переведи hello", "что значит idempotent?", "посчитай 17*4",
      "what time is it in Seoul?", "capital of Japan?", "translate reliable", "calculate 8/2",
    ];
    for (const text of sideQuestions) {
      const decision = router.route({ text, artifacts: [], focus, projects: [] });
      expect(decision.binding).toEqual({ type: "none" });
      expect(router.updateFocus(focus, decision.binding, text, decision.confidence)).toEqual(focus);
    }
  });

  it("turns every materially ambiguous expensive mutation into clarification", () => {
    const router = new RoutingEngine();
    const ambiguousTurns = [
      "исправь auth", "продолжи migration", "deploy the fix", "удали старый код",
      "run the release", "переделай API", "finish billing", "обнови схему",
      "apply the patch", "merge the redesign",
    ];
    for (const [index, text] of ambiguousTurns.entries()) {
      const result = router.route({
        text,
        artifacts: [],
        focus: emptyFocus,
        projects: [],
        threadCandidates: [
          { thread: thread(`candidate-a-${index}`), score: 0.84, reasons: ["semantic match"] },
          { thread: thread(`candidate-b-${index}`), score: 0.8, reasons: ["semantic match"] },
        ],
      });
      expect(result.shouldAsk).toBe(true);
      expect(result.binding.type).toBe("multi_thread");
    }
  });
});

function thread(id: string): WorkThread {
  return {
    id,
    t3ThreadId: id,
    projectId: "acme",
    title: "Similar active work",
    shortSummary: "potentially destructive production change",
    keywords: ["production"],
    status: "running",
    createdAt: timestamp,
    updatedAt: timestamp,
    lastActivityAt: timestamp,
    relatedArtifacts: [],
  };
}

function bindingKey(binding: ReturnType<RoutingEngine["route"]>["binding"]): string {
  if (binding.type === "thread") return `thread:${binding.threadId}`;
  if (binding.type === "project") return `project:${binding.projectId}`;
  return binding.type;
}
