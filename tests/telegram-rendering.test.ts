import { describe, expect, it } from "vitest";
import {
  DraftWriter,
  markdownToTelegramHtml,
  renderStreamPhase,
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

  it("drops GFM backslash escapes in the legacy fallback while keeping code literal (bug №23)", () => {
    const html = markdownToTelegramHtml(
      "Готово\\. Файлы\\: \\- src/x\\.ts \\(обновлён\\)\n\nЗапусти `pnpm vitest run tests/x\\.test\\.ts` \\> лог\\.",
    );
    expect(html).toContain("Готово. Файлы: - src/x.ts (обновлён)");
    expect(html).toContain(" &gt; лог.");
    expect(html).not.toContain("Готово\\.");
    expect(html).not.toContain("\\(обновлён\\)");
    // Inline code is literal: the backslash the user typed there survives.
    expect(html).toContain("<code>pnpm vitest run tests/x\\.test\\.ts</code>");
  });

  it("keeps escaped markdown markers as literal text instead of formatting them", () => {
    const html = markdownToTelegramHtml("Имя файла: \\*\\*important\\*\\*\\.md и \\`backtick\\`");
    expect(html).toContain("**important**.md");
    expect(html).not.toContain("<b>important</b>");
    expect(html).toContain("`backtick`");
  });

  it("turns a details spoiler into an expandable blockquote and degrades to a heading", () => {
    const markdown = "<details><summary>Размышления</summary>\n\nПроверил *файл*.\n\n> цитата\n\n</details>";
    const expandable = markdownToTelegramHtml(markdown);
    expect(expandable).toContain("<blockquote expandable><b>Размышления</b>");
    expect(expandable).toContain("<i>файл</i>");
    expect(expandable).toContain("</blockquote>");
    // Same-kind entities cannot nest inside the spoiler.
    expect(expandable).not.toContain("<blockquote>цитата</blockquote>");
    expect(expandable).not.toContain("&lt;details");
    const flat = markdownToTelegramHtml(markdown, { expandableBlockquote: false });
    expect(flat).toContain("<b>Размышления</b>");
    expect(flat).not.toContain("blockquote expandable");
    // A spoiler without a summary still gets a title.
    expect(markdownToTelegramHtml("<details>\nтело\n</details>")).toContain("<b>Подробности</b>");
  });

  it("renders single-marker italics without eating identifiers or bullets", () => {
    const html = markdownToTelegramHtml("Это *курсив*, и _тоже_, а snake_case_имя и **жирный** нет.\n\n* пункт списка");
    expect(html).toContain("<i>курсив</i>");
    expect(html).toContain("<i>тоже</i>");
    expect(html).toContain("snake_case_имя");
    expect(html).toContain("<b>жирный</b>");
    expect(html).toContain("* пункт списка");
    expect(markdownToTelegramHtml("\\*не курсив\\*")).toContain("*не курсив*");
  });

  it("lays markdown tables out in a monospaced block", () => {
    const html = markdownToTelegramHtml("| Имя | Итог |\n| --- | ---: |\n| **alpha** | ок |\n| b | 12 |\n\nхвост");
    expect(html).toContain("<pre>");
    expect(html).not.toContain("| --- |");
    const table = /<pre>([\s\S]*?)<\/pre>/u.exec(html)![1]!;
    const rows = table.split("\n");
    expect(rows[0]).toBe("Имя   | Итог");
    expect(rows[1]).toBe("------+-----");
    // Right alignment from `---:`, and cell markers stripped for the monospace box.
    expect(rows[2]).toBe("alpha |   ок");
    expect(rows[3]).toBe("b     |   12");
    expect(html.trimEnd().endsWith("хвост")).toBe(true);
  });

  it("turns images into links or plain alt text", () => {
    const html = markdownToTelegramHtml("Смотри ![схему](https://ex.com/a.png) и ![график](attachment://chart.png).");
    expect(html).toContain('<a href="https://ex.com/a.png">схему</a>');
    expect(html).toContain("график");
    expect(html).not.toContain("attachment://");
    expect(html).not.toContain("![");
    expect(markdownToTelegramHtml("![](attachment://x.png)")).toBe("изображение");
  });

  it("accepts every GFM delimiter row, not just three dashes (review B1)", () => {
    const variants = [
      "| Имя | Итог |\n|:-:|:-:|\n| a | b |",
      "| Имя | Итог |\n|-|-|\n| a | b |",
      "| Имя | Итог |\n|:--|--:|\n| a | b |",
    ];
    for (const table of variants) {
      const html = markdownToTelegramHtml(table);
      expect(html).toContain("<pre>");
      expect(html).not.toContain("|-");
      expect(html).not.toContain("| Имя | Итог |");
    }
    // Centering actually centers, right alignment actually right-aligns.
    const centered = /<pre>([\s\S]*?)<\/pre>/u.exec(markdownToTelegramHtml(variants[0]!))![1]!;
    // «Имя» is 3 wide and «Итог» 4, so a centred single character sits in the middle of both.
    expect(centered.split("\n")[2]).toBe(" a  |  b  ");
  });

  it("cannot have its own token markers forged from the user's text (review B2)", () => {
    for (const forged of ["@@CODEBLOCK0@@", "@@TG00000000_0@@", "@@TGdeadbeef_1@@"]) {
      const html = markdownToTelegramHtml(`${forged}\n\n\`\`\`\nсекрет фенса\n\`\`\`\n\n| a | b |\n|-|-|\n| ${forged} | y |`);
      // The literal survives as itself; it never picks up the fence's content.
      expect(html).toContain(forged.replaceAll("_", "_"));
      expect(html.split("секрет фенса").length - 1).toBe(1);
      // And no <pre> ever ends up nested inside the table box.
      expect(html).not.toMatch(/<pre>[^<]*<pre>/u);
    }
  });

  it("keeps replacement patterns in code literal (review T1)", () => {
    const html = markdownToTelegramHtml("```sh\necho \"$& $' $` $$ $1\"\n```\n\nи `$&` в строке");
    expect(html).toContain("echo &quot;$&amp; $' $` $$ $1&quot;");
    expect(html).toContain("<code>$&amp;</code>");
  });

  it("converts a table inside a spoiler, the way tool output arrives (review M1)", () => {
    const html = markdownToTelegramHtml(
      renderStreamPhase("tools", "| Шаг | Итог |\n|-|-|\n| build | ок |"),
    );
    expect(html).toContain("<blockquote expandable><b>Работа инструментов</b>");
    expect(html).toContain("<pre>");
    expect(html).not.toContain("|-|-|");
    // <pre> inside the expandable quote is the only nesting Telegram allows here.
    expect(html).not.toContain("<blockquote expandable><blockquote");
  });

  it("keeps a pipe inside inline code from breaking the columns (review M5)", () => {
    const html = markdownToTelegramHtml("| Команда | Итог |\n|-|-|\n| `a \\| b` | ок |\n| x | y |");
    const rows = /<pre>([\s\S]*?)<\/pre>/u.exec(html)![1]!.split("\n");
    expect(rows).toHaveLength(4);
    expect(rows[2]).toContain("a \\| b");
    // No entity is nested inside the monospaced box.
    expect(rows[2]).not.toContain("<code>");
  });

  it("flattens a quoted spoiler instead of nesting quotes (review M4)", () => {
    const html = markdownToTelegramHtml("> <details><summary>Итог</summary>\n> тело\n> </details>");
    expect(html).toContain("<blockquote expandable><b>Итог</b>");
    expect(html).not.toMatch(/<blockquote>\s*<blockquote/u);
    expect(html).not.toContain("&gt;");
    expect(html).toContain("тело");
  });

  it("leaves no stray tags when spoilers are nested", () => {
    const html = markdownToTelegramHtml(
      "<details><summary>Внешний</summary>\n\n<details><summary>Внутренний</summary>\n\nтело\n\n</details>\n\n</details>",
    );
    expect(html).not.toContain("&lt;/details&gt;");
    expect(html).not.toContain("&lt;details");
    expect(html).toContain("<b>Внешний</b>");
    expect(html).toContain("<b>Внутренний</b>");
  });

  it("trims wide cells and ragged rows in the monospaced box", () => {
    const html = markdownToTelegramHtml(`| Имя | Итог |\n|-|-|\n| ${"я".repeat(60)} | ок |\n| одна |`);
    const rows = /<pre>([\s\S]*?)<\/pre>/u.exec(html)![1]!.split("\n");
    expect(rows[2]).toContain("…");
    expect(rows.every((row) => row.length <= 40)).toBe(true);
    expect(rows.every((row) => !/[\s|]$/u.test(row))).toBe(true);
  });

  it("never nests a blockquote, in any spoiler shape or mode (review R1/R2)", () => {
    // Telegram refuses same-kind nested entities. Every rejection costs the
    // message its formatting and — since the flat retry works — latches the
    // expandable capability off for every chat, so this is an invariant, not
    // a per-shape fix.
    const inspect = (html: string): string | null => {
      const scan = /<blockquote(?: expandable)?>|<\/blockquote>|<pre>|<\/pre>/gu;
      let depth = 0;
      let pre = 0;
      for (const match of html.matchAll(scan)) {
        if (match[0] === "</blockquote>") depth -= 1;
        else if (match[0] === "<pre>") {
          pre += 1;
          if (pre > 1) return "nested <pre>";
        } else if (match[0] === "</pre>") pre -= 1;
        else {
          depth += 1;
          if (depth > 1) return `nested <blockquote> at ${match.index}`;
        }
        if (depth < 0 || pre < 0) return "unbalanced";
      }
      return depth || pre ? "unbalanced" : null;
    };
    const cases: Array<[string, string]> = [
      ["цитата с абзацем перед спойлером", "> текст до\n>\n> <details><summary>Th</summary>\n> строка 1\n> </details>"],
      ["цитата без пустой строки", "> текст до\n> <details><summary>Th</summary>\n> строка\n> </details>"],
      ["голая цитата-спойлер", "> <details><summary>Th</summary>\n> body\n> </details>"],
      ["цитата с текстом после", "> <details><summary>Th</summary>\n> body\n> </details>\n> текст после"],
      ["вложенные спойлеры", "<details><summary>A</summary>\n<details><summary>B</summary>\ninner\n</details>\n</details>"],
      ["три уровня", "<details><summary>A</summary>\n<details><summary>B</summary>\n<details><summary>C</summary>\nz\n</details>\n</details>\n</details>"],
      ["цитата внутри спойлера", "<details><summary>S</summary>\n\n> q\n\n</details>"],
      ["таблица внутри спойлера", "<details><summary>S</summary>\n\n| a |\n|---|\n| 1 |\n\n</details>"],
      ["фенс внутри спойлера", "<details><summary>S</summary>\n\n```\nx\n```\n\n</details>"],
      // The way it actually reaches production: the phase wrapper around model
      // output that carries a spoiler of its own (review R1).
      ["спойлер модели внутри стрим-обёртки", renderStreamPhase("thinking", "<details><summary>Своё</summary>\n\nтело\n\n</details>")],
    ];
    for (const [name, markdown] of cases) {
      for (const expandableBlockquote of [true, false]) {
        const html = markdownToTelegramHtml(markdown, { expandableBlockquote });
        expect(`${name} (expandable=${expandableBlockquote}): ${inspect(html)}`).toBe(
          `${name} (expandable=${expandableBlockquote}): null`,
        );
      }
    }
  });

  it("keeps the inner spoiler's content when it flattens the nesting (review R1)", () => {
    const html = markdownToTelegramHtml(
      "<details><summary>Внешний</summary>\n\nснаружи\n\n<details><summary>Внутренний</summary>\n\nвнутри\n\n</details>\n\n</details>",
    );
    expect(html).toContain("<b>Внешний</b>");
    expect(html).toContain("<b>Внутренний</b>");
    expect(html).toContain("снаружи");
    expect(html).toContain("внутри");
    expect(html.match(/<blockquote expandable>/gu)).toHaveLength(1);
  });

  it("drops the orphaned quote marker in front of a flattened spoiler (review R2)", () => {
    const html = markdownToTelegramHtml("> текст до\n>\n> <details><summary>Th</summary>\n> строка 1\n> </details>");
    expect(html).toContain("текст до");
    expect(html).toContain("строка 1");
    expect(html).not.toContain("&gt; <");
    expect(html).not.toMatch(/&gt;\s*$/u);
  });

  it("never exceeds a limit smaller than the truncation marker", () => {
    const marker = "_… начало вывода обрезано …_\n\n";
    for (const limit of [1, 5, marker.length - 1, marker.length, marker.length + 1, marker.length + 40]) {
      const preview = truncateRichPreview("абвгдежзийклмнопрстуфхцч".repeat(20), limit);
      expect(preview.length).toBeLessThanOrEqual(limit);
      expect(preview.length).toBeGreaterThan(0);
    }
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
    expect(preview.startsWith("_… начало вывода обрезано …_\n\n")).toBe(true);
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
