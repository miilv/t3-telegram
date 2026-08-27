import { describe, expect, it } from "vitest";
import * as policy from "../packages/policy/src/index.js";

function draft(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key: "warehouse-owner",
    description: "when warehouse ownership matters → read the owner fact",
    content: "Даня ведёт склад",
    category: "people",
    evidenceSeqs: [7],
    validUntil: null,
    ...overrides,
  };
}

function rejected(value: unknown, evidence = new Map([[7, "Даня ведёт склад"]])): void {
  expect(policy.parseDistillationResponse(
    typeof value === "string" ? value : JSON.stringify(value),
    evidence,
  )).toMatchObject({ ok: false });
}

describe("conversation distillation response policy", () => {
  it("accepts only the exact quiet sentinel after edge whitespace", () => {
    const parse = (policy as Record<string, unknown>).parseDistillationResponse;
    expect(typeof parse).toBe("function");
    expect((parse as (value: string, evidence: Map<number, string>) => unknown)(
      "\nNOTHING\t",
      new Map(),
    )).toEqual({ ok: true, kind: "nothing", candidates: [] });
  });

  it("accepts a bounded exact-shape draft and preserves accepted content characters", () => {
    const parse = policy.parseDistillationResponse;
    const response = JSON.stringify([{
      key: "warehouse-owner",
      description: "when warehouse ownership matters → read the owner fact",
      content: "① Даня ﬁ ведёт склад",
      category: "people",
      evidenceSeqs: [7],
      validUntil: null,
    }]);

    expect(parse(response, new Map([[7, "Даня ведёт склад"]]))).toEqual({
      ok: true,
      kind: "candidates",
      candidates: [{
        key: "warehouse-owner",
        description: "when warehouse ownership matters → read the owner fact",
        content: "① Даня ﬁ ведёт склад",
        category: "people",
        evidenceSeqs: [7],
        validUntil: null,
      }],
    });
  });

  it("rejects fences, trailing prose, alternate sentinels, empty arrays and oversized arrays", () => {
    rejected("```json\n[]\n```");
    rejected(`${JSON.stringify([draft()])}\nlooks good`);
    rejected("nothing");
    rejected([]);
    rejected(Array.from({ length: 21 }, (_, index) => draft({ key: `fact-${index}` })));
  });

  it("rejects unknown or missing fields, invalid types/dates/drafts and duplicate normalized keys", () => {
    rejected([draft({ extra: true })]);
    const missing = draft();
    delete missing.category;
    rejected([missing]);
    rejected([draft({ content: 42 })]);
    rejected([draft({ validUntil: "2026-02-30T00:00:00.000Z" })]);
    rejected([draft({ validUntil: "2026-08-26" })]);
    rejected([draft({ description: "summary without trigger arrow" })]);
    rejected([draft({ content: "line one\nline two" })]);
    rejected([
      draft({ key: "Warehouse Owner" }),
      draft({ key: "warehouse-owner", evidenceSeqs: [8] }),
    ], new Map([[7, "first"], [8, "second"]]));
  });

  it("rejects empty, repeated, out-of-batch, context-only or blank owner evidence citations", () => {
    rejected([draft({ evidenceSeqs: [] })]);
    rejected([draft({ evidenceSeqs: [7, 7] })]);
    rejected([draft({ evidenceSeqs: [8] })]);
    rejected([draft({ evidenceSeqs: [8] })], new Map([[8, ""]]));
    rejected([draft({ evidenceSeqs: [9] })], new Map([[7, "owner fact"]]));
  });

  it("builds one bounded redacted prompt and exposes only nonempty owner assertions as evidence", () => {
    const build = (policy as Record<string, unknown>).buildDistillationPrompt;
    expect(typeof build).toBe("function");
    const result = (build as (input: unknown) => {
      prompt: string;
      ownerEvidence: ReadonlyMap<number, string>;
    })({
      ownerId: "42",
      afterSeq: 0,
      highWaterSeq: 4,
      throughSeq: 4,
      entries: [
        {
          seq: 1,
          direction: "inbound",
          evidenceRole: "owner_assertion",
          text: "Forward says api_key=forward-secret; owner adds a fact",
          evidenceText: "Owner adds password=owner-secret",
        },
        {
          seq: 2,
          direction: "outbound",
          evidenceRole: "context_only",
          text: "Assistant guessed token=assistant-secret",
        },
        {
          seq: 3,
          direction: "inbound",
          evidenceRole: "context_only",
          text: "Forwarded third-party assertion",
        },
        {
          seq: 4,
          direction: "inbound",
          evidenceRole: "owner_assertion",
          text: "Captionless placeholder",
          evidenceText: "   ",
        },
      ],
    });

    expect(result.prompt).toContain('"seq":1');
    expect(result.prompt).toContain('"direction":"inbound"');
    expect(result.prompt).toContain('"evidenceRole":"owner_assertion"');
    expect(result.prompt).toContain('"seq":2');
    expect(result.prompt).toContain('"evidenceRole":"context_only"');
    expect(result.prompt).toContain("api_key=[REDACTED]");
    expect(result.prompt).toContain("password=[REDACTED]");
    expect(result.prompt).toContain("token=[REDACTED]");
    expect(result.prompt).not.toContain("forward-secret");
    expect(result.prompt).not.toContain("owner-secret");
    expect(result.prompt).not.toContain("assistant-secret");
    expect([...result.ownerEvidence.keys()]).toEqual([1]);
    expect(result.ownerEvidence.get(1)).toBe("Owner adds password=[REDACTED]");
    expect([...result.prompt].length).toBeLessThanOrEqual(
      policy.DISTILLATION_PROMPT_MAX_CHARS,
    );
  });

  it("renders a privacy-safe owner merge proposal without raw provider prompt text", () => {
    const render = (policy as Record<string, unknown>).buildDistillationMergeProposalPrompt;
    expect(typeof render).toBe("function");
    const prompt = (render as (input: unknown) => string)({
      candidateKey: "warehouse-contact",
      description: "when contact matters → password=candidate-secret",
      evidenceSeqs: [3, 7],
      matchingNote: {
        id: "note_stable_123",
        key: "warehouse-owner",
        description: "when ownership matters → token=existing-secret",
      },
    });

    expect(prompt).toContain("warehouse-contact");
    expect(prompt).toContain("warehouse-owner");
    expect(prompt).toContain("note_stable_123");
    expect(prompt).toContain("3, 7");
    expect(prompt).toContain("password=[REDACTED]");
    expect(prompt).toContain("token=[REDACTED]");
    expect(prompt).not.toContain("candidate-secret");
    expect(prompt).not.toContain("existing-secret");
    expect(prompt).not.toContain("provider prompt");
  });
});
