import { mkdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RoutingEngine, shouldDelegate } from "../packages/router/src/index.js";
import { nowIso, type FocusState, type Project } from "../packages/shared/src/index.js";
import { tempDirectory, tempStore } from "./helpers.js";

const emptyFocus: FocusState = { secondary: [] };

describe("RoutingEngine", () => {
  it("routes Telegram replies deterministically", () => {
    const router = new RoutingEngine();
    const result = router.route({
      text: "продолжай",
      replyThreadId: "th_b",
      artifacts: [],
      focus: emptyFocus,
      projects: [],
    });
    expect(result.binding).toEqual({ type: "thread", threadId: "th_b" });
    expect(result.confidence).toBeGreaterThan(0.95);
  });

  it("preserves focus for unrelated factual questions and uses it for follow-ups", () => {
    const store = tempStore();
    const timestamp = nowIso();
    store.upsertProject({
      id: "prj_acme",
      t3ProjectId: "prj_acme",
      name: "Acme",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    store.upsertThread({
      id: "th_auth",
      t3ThreadId: "th_auth",
      projectId: "prj_acme",
      title: "Auth bug",
      shortSummary: "",
      keywords: ["auth"],
      status: "running",
      createdAt: timestamp,
      updatedAt: timestamp,
      lastActivityAt: timestamp,
      relatedArtifacts: [],
    });
    const router = new RoutingEngine(store);
    const focus: FocusState = {
      primary: {
        projectId: "prj_acme",
        threadId: "th_auth",
        topic: "fix auth refresh",
        confidence: 0.95,
        updatedAt: timestamp,
      },
      secondary: [],
    };
    const side = router.route({
      text: "который час в Токио?",
      artifacts: [],
      focus,
      projects: store.listProjects(),
    });
    expect(side.binding).toEqual({ type: "none" });
    expect(router.updateFocus(focus, side.binding, "time", side.confidence)).toEqual(focus);

    const followUp = router.route({
      text: "готово?",
      artifacts: [],
      focus,
      projects: store.listProjects(),
    });
    expect(followUp.binding).toEqual({ type: "thread", threadId: "th_auth" });
    store.close();
  });

  it("matches an absolute path to the owning project", () => {
    const root = tempDirectory("acme-root-");
    const nested = `${root}/src/auth`;
    mkdirSync(nested, { recursive: true });
    const project: Project = {
      id: "prj_acme",
      t3ProjectId: "prj_acme",
      name: "Acme API",
      workspaceRoot: root,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    const result = new RoutingEngine().route({
      text: `проверь ${nested}`,
      artifacts: [],
      focus: emptyFocus,
      projects: [project],
    });
    expect(result.binding).toEqual({ type: "project", projectId: "prj_acme" });
    expect(result.confidence).toBeGreaterThan(0.95);
  });

  it("delegates substantial work but not a simple fact", () => {
    expect(shouldDelegate("исправь race condition и прогони тесты", [], { type: "none" })).toBe(true);
    expect(shouldDelegate("столица Франции?", [], { type: "none" })).toBe(false);
  });

  it("asks instead of choosing arbitrarily between close thread candidates", () => {
    const timestamp = nowIso();
    const makeThread = (id: string, title: string) => ({
      id,
      t3ThreadId: id,
      projectId: "prj_acme",
      title,
      shortSummary: "auth work",
      keywords: ["auth"],
      status: "idle" as const,
      createdAt: timestamp,
      updatedAt: timestamp,
      lastActivityAt: timestamp,
      relatedArtifacts: [],
    });
    const result = new RoutingEngine().route({
      text: "продолжи auth",
      artifacts: [],
      focus: emptyFocus,
      projects: [],
      threadCandidates: [
        { thread: makeThread("th_bug", "Production auth bug"), score: 0.86, reasons: ["match"] },
        { thread: makeThread("th_redesign", "Auth redesign"), score: 0.82, reasons: ["match"] },
      ],
    });
    expect(result.shouldAsk).toBe(true);
    expect(result.binding).toEqual({
      type: "multi_thread",
      threadIds: ["th_bug", "th_redesign"],
    });
  });
});
