import { describe, expect, it } from "vitest";
import { markdownToTelegramHtml, splitRichText } from "../packages/telegram/src/index.js";

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
});
