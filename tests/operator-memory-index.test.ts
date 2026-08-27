import { describe, expect, it } from "vitest";
import { currentMemoryNotesForPush } from "../apps/daemon/src/operator-memory-index.js";
import { renderMemoryIndex } from "../packages/policy/src/index.js";
import { tempStore } from "./helpers.js";

describe("Operator memory-index product selection", () => {
  it("ranks the complete active set before the display budget", () => {
    const store = tempStore();
    const old = store.notes.writeVersion({
      key: "older-important",
      category: "preference",
      description: "when important history matters → read older-important",
      content: "pull-only older important body",
      source: "manual",
      operationKey: "push:older-important",
    }).note;
    const lowIds: string[] = [];
    for (let index = 0; index < 200; index += 1) {
      lowIds.push(store.notes.writeVersion({
        key: `newer-low-${String(index).padStart(3, "0")}`,
        category: "general",
        description: `when low priority ${index} matters → read newer-low-${index}`,
        content: `pull-only newer low body ${index}`,
        source: "manual",
        operationKey: `push:newer-low:${index}`,
      }).note.id);
    }
    store.db.prepare("UPDATE operator_notes SET updated_at=?,access_count=31 WHERE id=?")
      .run("2026-08-26T00:00:00.000Z", old.id);
    lowIds.forEach((id, index) => {
      store.db.prepare("UPDATE operator_notes SET updated_at=?,access_count=0 WHERE id=?")
        .run(new Date(Date.UTC(2026, 7, 26, 0, 0, index + 1)).toISOString(), id);
    });

    const selected = currentMemoryNotesForPush(store, new Date("2026-08-27T00:00:00.000Z"));
    const rendered = renderMemoryIndex(selected.index);

    expect(rendered).toContain("older-important");
    expect(rendered).not.toContain("newer-low-000");
    expect(rendered).not.toContain("pull-only older important body");
    expect(selected.index).toHaveLength(201);
    store.close();
  });
});
