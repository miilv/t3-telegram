import { describe, expect, it } from "vitest";
import {
  DraftWriter,
  markdownToTelegramHtml,
  splitRichText,
  truncateRichPreview,
} from "../packages/telegram/src/index.js";

describe("Telegram rich rendering", () => {
  it("renders headings, emphasis, code and links to supported HTML", () => {
    const html = markdownToTelegramHtml("# Result\n\n**Done** with `pnpm test`. [Docs](https://example.com)\n\n```ts\nconst x = 1 < 2;\n```");
    expect(html).toContain("<b>Result</b>");
    expect(html).toContain("<b>Done</b>");
    expect(html).toContain("<code>pnpm test</code>");
    expect(html).toContain('<a href="https://example.com">Docs</a>');
    expect(html).toContain("1 &lt; 2");
  });

  it("splits long output below Telegram-safe limits", () => {
    const chunks = splitRichText(Array.from({ length: 200 }, (_, index) => `Paragraph ${index}: ${"x".repeat(40)}`).join("\n\n"), 500);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 500)).toBe(true);
  });

  it("re-wraps long fenced code blocks so every chunk stays valid", () => {
    const code = `\`\`\`ts\n${Array.from({ length: 80 }, (_, index) => `const value${index} = ${index};`).join("\n")}\n\`\`\``;
    const chunks = splitRichText(code, 240);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 240)).toBe(true);
    expect(chunks.every((chunk) => chunk.startsWith("```ts\n") && chunk.endsWith("\n```"))).toBe(true);
  });

  it("keeps table headers, details wrappers, and media references valid across splits", () => {
    const table = [
      "| Name | Result |",
      "| --- | --- |",
      ...Array.from({ length: 20 }, (_, index) => `| check-${index} | ${"ok ".repeat(8)} |`),
    ].join("\n");
    const chunks = splitRichText(`${table}\n\n<details><summary>Evidence</summary>\n${"fact ".repeat(80)}\n</details>\n\n![chart](attachment://chart.png)`, 180);
    const tableChunks = chunks.filter((chunk) => chunk.startsWith("| Name"));
    expect(tableChunks.length).toBeGreaterThan(1);
    expect(tableChunks.every((chunk) => chunk.startsWith("| Name | Result |\n| --- | --- |"))).toBe(true);
    expect(chunks.filter((chunk) => chunk.startsWith("<details")).every((chunk) => chunk.endsWith("</details>"))).toBe(true);
    expect(chunks.some((chunk) => chunk.includes("![chart](attachment://chart.png)"))).toBe(true);
    expect(chunks.every((chunk) => chunk.length <= 180)).toBe(true);
  });

  it("marks head truncation with a leading marker that the slice can never cut", () => {
    const lines = Array.from({ length: 400 }, (_, index) => `line ${index}: ${"x".repeat(30)}`);
    const text = lines.join("\n");
    const preview = truncateRichPreview(text, 2_000);
    // It is the beginning of the stream that was dropped, so the marker says
    // so and leads the preview instead of trailing it (bug №39).
    expect(preview.startsWith("_… earlier output trimmed …_\n\n")).toBe(true);
    expect(preview.length).toBeLessThanOrEqual(2_000);
    // The freshest output survives intact.
    expect(preview.endsWith(lines.at(-1)!)).toBe(true);
    // Short text passes through untouched.
    expect(truncateRichPreview("короткий ответ", 2_000)).toBe("короткий ответ");
  });

  it("splits whitespace-free payloads at the limit instead of one-character chunks", () => {
    const blob = "A".repeat(9000);
    const chunks = splitRichText(blob, 3800);
    expect(chunks.length).toBe(3);
    expect(Math.max(...chunks.map((chunk) => chunk.length))).toBeLessThanOrEqual(3800);
    expect(chunks.join("")).toBe(blob);
    expect(chunks.every((chunk) => chunk.length > 0)).toBe(true);
  });
});

describe("DraftWriter keep-alive", () => {
  function fakeTransport() {
    const updates: string[] = [];
    return {
      updates,
      transport: {
        updateDraft: async (_draft: unknown, text: string) => {
          updates.push(text);
        },
        finalizeDraft: async () => [],
      } as unknown as ConstructorParameters<typeof DraftWriter>[0],
    };
  }

  it("refreshes a silent preview with the placeholder", async () => {
    const { updates, transport } = fakeTransport();
    const writer = new DraftWriter(transport, { mode: "rich-draft", chatId: 7, draftId: 1, text: "…" } as never);
    // A tool-heavy turn writes no deltas at all; without a refresh Telegram
    // drops the draft and the preview disappears from the chat.
    writer.refresh("⏳ Работаю… 30 с, шагов: 4");
    await writer.closePreview();
    expect(updates).toEqual(["⏳ Работаю… 30 с, шагов: 4"]);
  });

  it("refreshes with the model's own commentary when it exists", async () => {
    const { updates, transport } = fakeTransport();
    const writer = new DraftWriter(transport, { mode: "rich-draft", chatId: 7, draftId: 2, text: "…" } as never);
    writer.append("Смотрю логи авторизации.");
    writer.refresh("⏳ Работаю…");
    await writer.closePreview();
    expect(updates.at(-1)).toBe("Смотрю логи авторизации.");
  });

  it("stays silent once the preview is closed", async () => {
    const { updates, transport } = fakeTransport();
    const writer = new DraftWriter(transport, { mode: "rich-draft", chatId: 7, draftId: 3, text: "…" } as never);
    await writer.closePreview();
    writer.refresh("⏳ Работаю…");
    expect(updates).toEqual([]);
  });
});
