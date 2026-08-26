const LEGACY_SAFE_LIMIT = 4000;
export const RICH_SAFE_LIMIT = 30_000;

export function splitRichText(text: string, limit = LEGACY_SAFE_LIMIT): string[] {
  if (text.length <= limit) return [text];
  const segments = tokenizeFencedBlocks(text).flatMap((segment) =>
    segment.trimStart().startsWith("```") ? [segment] : tokenizeAtomicMarkdownBlocks(segment),
  );
  const chunks: string[] = [];
  let current = "";
  for (const segment of segments) {
    const separator = current && !current.endsWith("\n") && !segment.startsWith("\n") ? "\n\n" : "";
    if (current.length + separator.length + segment.length <= limit) {
      current += `${separator}${segment}`;
      continue;
    }
    if (current) chunks.push(current);
    current = "";
    if (segment.length <= limit) {
      current = segment;
      continue;
    }
    if (segment.trimStart().startsWith("```")) {
      chunks.push(...splitFencedBlock(segment.trim(), limit));
    } else if (isMarkdownTable(segment)) {
      chunks.push(...splitMarkdownTable(segment.trim(), limit));
    } else if (segment.trimStart().startsWith("<details")) {
      chunks.push(...splitDetailsBlock(segment.trim(), limit));
    } else {
      const plainChunks = splitPlainText(segment, limit);
      chunks.push(...plainChunks.slice(0, -1));
      current = plainChunks.at(-1) ?? "";
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function tokenizeAtomicMarkdownBlocks(text: string): string[] {
  const lines = text.split(/(?<=\n)/u);
  const segments: string[] = [];
  let plain = "";
  const flushPlain = () => {
    if (plain) segments.push(plain);
    plain = "";
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const trimmed = line.trim();
    if (trimmed.startsWith("<details")) {
      flushPlain();
      let block = line;
      while (!block.includes("</details>") && index + 1 < lines.length) block += lines[++index]!;
      segments.push(block);
      continue;
    }
    if (
      trimmed.startsWith("|") &&
      index + 1 < lines.length &&
      /^\s*\|?\s*:?-{3,}/u.test(lines[index + 1]!)
    ) {
      flushPlain();
      let table = line + lines[++index]!;
      while (index + 1 < lines.length && lines[index + 1]!.trimStart().startsWith("|")) {
        table += lines[++index]!;
      }
      segments.push(table);
      continue;
    }
    if (/^!\[[^\]]*\]\([^\n]+\)\s*$/u.test(trimmed)) {
      flushPlain();
      segments.push(line);
      continue;
    }
    plain += line;
  }
  flushPlain();
  return segments.filter(Boolean);
}

function isMarkdownTable(value: string): boolean {
  const lines = value.trim().split("\n");
  return lines.length >= 2 && lines[0]!.trimStart().startsWith("|") && /^\s*\|?\s*:?-{3,}/u.test(lines[1]!);
}

function splitMarkdownTable(table: string, limit: number): string[] {
  const lines = table.split("\n").filter(Boolean);
  const header = lines.slice(0, 2).join("\n");
  if (header.length > limit) return splitPlainText(table, limit);
  const chunks: string[] = [];
  let current = header;
  for (const row of lines.slice(2)) {
    if (row.length + header.length + 1 > limit) {
      if (current !== header) chunks.push(current);
      chunks.push(...splitPlainText(row, limit));
      current = header;
      continue;
    }
    if (current.length + row.length + 1 > limit) {
      chunks.push(current);
      current = `${header}\n${row}`;
    } else {
      current += `\n${row}`;
    }
  }
  if (current !== header || !chunks.length) chunks.push(current);
  return chunks;
}

function splitDetailsBlock(block: string, limit: number): string[] {
  const open = /^(<details[^>]*>\s*(?:<summary>[\s\S]*?<\/summary>)?)/iu.exec(block)?.[1] ?? "<details>";
  const close = "</details>";
  const inner = block.slice(open.length, block.toLocaleLowerCase().lastIndexOf(close)).trim();
  const allowance = Math.max(1, limit - open.length - close.length - 2);
  return splitPlainText(inner, allowance).map((piece) => `${open}\n${piece}\n${close}`);
}

export function truncateRichPreview(text: string, limit = RICH_SAFE_LIMIT): string {
  if (text.length <= limit) return text || "…";
  // It is the beginning of the stream that gets dropped, so the marker says
  // so, leads the preview, and stays outside the sliced tail so no final
  // slice can ever cut the marker itself (bug №39).
  const marker = "_… начало вывода обрезано …_\n\n";
  // A limit too small to hold the marker plus any text at all must still be
  // honoured: dropping the marker is better than returning more than asked
  // for (package 4.2 — the marker used to push the result past the limit).
  if (limit <= marker.length) return text.slice(text.length - Math.max(1, limit));
  let preview = text.slice(text.length - Math.max(1, limit - marker.length));
  const firstLineBreak = preview.indexOf("\n");
  if (firstLineBreak > 0 && firstLineBreak < 300) preview = preview.slice(firstLineBreak + 1);
  return `${marker}${preview}`;
}

export function renderStreamPhase(phase: "thinking" | "tools" | "text", text: string): string {
  if (phase === "text") return text;
  const title = phase === "thinking" ? "Размышления" : "Работа инструментов";
  // Keep math outside details: some Telegram Desktop builds have crashed on
  // math nested in a details block (Hermes Agent production guard).
  if (/\$\$|```math|<tg-math/i.test(text)) return `### ${title}\n\n${text}`;
  return `<details><summary>${title}</summary>\n\n${text}\n\n</details>`;
}

export interface TelegramHtmlOptions {
  /**
   * `<blockquote expandable>` is the Telegram expression of a `<details>`
   * spoiler. Callers latch this to false once a chat has rejected it and get
   * the degraded «заголовок + текст» shape instead.
   */
  expandableBlockquote?: boolean;
}

export function markdownToTelegramHtml(markdown: string, options: TelegramHtmlOptions = {}): string {
  const expandable = options.expandableBlockquote !== false;
  // One shared token store for every literal fragment that must survive the
  // markdown replacements: fenced code, inline code, tables and details
  // bodies. A token's HTML may itself contain earlier tokens, which is why
  // the substitution below walks the store backwards.
  const blocks: string[] = [];
  const tokenize = (html: string): string => {
    blocks.push(html);
    return `@@CODEBLOCK${blocks.length - 1}@@`;
  };
  let value = markdown.replace(/```(?:[\w+-]+)?\n?([\s\S]*?)```/g, (_match, code: string) =>
    tokenize(`<pre><code>${escapeHtml(code.trimEnd())}</code></pre>`),
  );
  // Spoilers and tables are lifted out before escaping: their markup is
  // structure, not text the user typed (bugs: bare <details> tags and pipe
  // soup in a proportional font).
  value = value.replace(
    /<details[^>]*>\s*(?:<summary>([\s\S]*?)<\/summary>)?([\s\S]*?)<\/details>/giu,
    (_match, summary: string | undefined, body: string) => {
      const title = `<b>${convertInline(summary?.trim() || "Подробности", tokenize)}</b>`;
      const inner = convertInline(body.trim(), tokenize);
      if (!expandable) return tokenize(`${title}\n\n${inner}`);
      // Telegram entities of the same kind cannot nest, so a quote inside the
      // spoiler is flattened rather than risking a formatting error.
      const flat = inner.replaceAll("<blockquote>", "").replaceAll("</blockquote>", "");
      return tokenize(`<blockquote expandable>${title}\n\n${flat}</blockquote>`);
    },
  );
  value = replaceMarkdownTables(value, tokenize);
  value = convertInline(value, tokenize);
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    value = value.split(`@@CODEBLOCK${index}@@`).join(blocks[index]!);
  }
  return value;
}

function convertInline(markdown: string, tokenize: (html: string) => string): string {
  const value = escapeHtml(markdown)
    .replace(/(?<!\\)`((?:[^`\n\\]|\\[^`\n])+)`/g, (_match, code: string) =>
      // Inline code is literal content: protect it from the markdown
      // replacements below and from GFM backslash unescaping alike.
      tokenize(`<code>${code}</code>`),
    )
    .replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>")
    .replace(/^&gt;\s?(.+)$/gm, "<blockquote>$1</blockquote>")
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/__(.+?)__/g, "<b>$1</b>")
    // Single-marker italics, after the double-marker bold so `**x**` is not
    // eaten by them. Word-adjacency guards keep snake_case identifiers and
    // list bullets («* item») intact.
    .replace(/(?<![\w*\\])\*(?!\s)([^*\n]+?)(?<![\s\\])\*(?![\w*])/g, "<i>$1</i>")
    .replace(/(?<![\w_\\])_(?!\s)([^_\n]+?)(?<![\s\\])_(?![\w_])/g, "<i>$1</i>")
    // Images have no place in a text message: a real URL becomes a link, an
    // attachment reference degrades to its alt text. Runs before the link
    // rule so the leading «!» never survives as litter.
    .replace(/!\[([^\]]*)]\((https?:\/\/[^\s)]+)\)/g, (_match, alt: string, url: string) =>
      `<a href="${url}">${alt.trim() || "изображение"}</a>`,
    )
    .replace(/!\[([^\]]*)]\([^\s)]*\)/g, (_match, alt: string) => alt.trim() || "изображение")
    .replace(/\[([^\]]+)]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
  // The legacy fallback receives the same GFM the rich path shows verbatim, so
  // backslash-escaped punctuation («Готово\.») must render without the
  // backslash here too (bug №23). Runs after the markdown replacements so an
  // escaped marker (\*\*) stays literal text instead of turning into <b>, and
  // covers the HTML-entity forms escapeHtml produced (\&gt; etc.).
  return value.replace(/\\(&(?:amp|lt|gt|quot);|[!-/:-@[-`{-~])/g, "$1");
}

function replaceMarkdownTables(value: string, tokenize: (html: string) => string): string {
  const lines = value.split("\n");
  const out: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const next = lines[index + 1];
    if (!line.trimStart().startsWith("|") || !next || !/^\s*\|?\s*:?-{3,}/u.test(next)) {
      out.push(line);
      continue;
    }
    const rows = [line, next];
    let cursor = index + 2;
    while (cursor < lines.length && lines[cursor]!.trimStart().startsWith("|")) {
      rows.push(lines[cursor]!);
      cursor += 1;
    }
    index = cursor - 1;
    out.push(tokenize(tableToPre(rows)));
  }
  return out.join("\n");
}

function tableToPre(rows: string[]): string {
  const cells = rows.map((row) =>
    row
      .trim()
      .replace(/^\|/u, "")
      .replace(/\|$/u, "")
      .split("|")
      .map((cell) => cell.trim().replace(/\*\*|__|[*_`]/gu, "")),
  );
  const alignment = (cells[1] ?? []).map((spec) =>
    spec.startsWith(":") && spec.endsWith(":") ? "center" : spec.endsWith(":") ? "right" : "left",
  );
  const body = cells.filter((_row, index) => index !== 1);
  const columns = Math.max(...body.map((row) => row.length));
  const widths = Array.from({ length: columns }, (_unused, column) =>
    Math.max(1, ...body.map((row) => (row[column] ?? "").length)),
  );
  const render = (row: string[]): string =>
    widths.map((width, column) => pad(row[column] ?? "", width, alignment[column] ?? "left")).join(" | ").trimEnd();
  const rendered = body.map(render);
  const ruler = widths.map((width) => "-".repeat(width)).join("-+-");
  const lines = [rendered[0] ?? "", ruler, ...rendered.slice(1)];
  return `<pre>${escapeHtml(lines.join("\n"))}</pre>`;
}

function pad(value: string, width: number, alignment: "left" | "right" | "center"): string {
  const gap = Math.max(0, width - value.length);
  if (alignment === "right") return " ".repeat(gap) + value;
  if (alignment === "center") return " ".repeat(Math.floor(gap / 2)) + value + " ".repeat(Math.ceil(gap / 2));
  return value + " ".repeat(gap);
}

function tokenizeFencedBlocks(text: string): string[] {
  const segments: string[] = [];
  const pattern = /```[^\n]*\n[\s\S]*?```/g;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index;
    if (index > cursor) segments.push(text.slice(cursor, index));
    segments.push(match[0]);
    cursor = index + match[0].length;
  }
  if (cursor < text.length) segments.push(text.slice(cursor));
  return segments.filter(Boolean);
}

function splitFencedBlock(block: string, limit: number): string[] {
  const firstNewline = block.indexOf("\n");
  const header = firstNewline >= 0 ? block.slice(0, firstNewline) : "```";
  const body = firstNewline >= 0 ? block.slice(firstNewline + 1, block.endsWith("```") ? -3 : undefined) : "";
  const allowance = Math.max(1, limit - header.length - 5);
  const pieces = splitPlainText(body, allowance);
  return pieces.map((piece) => `${header}\n${piece.trimEnd()}\n\`\`\``);
}

function splitPlainText(text: string, limit: number): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    const window = remaining.slice(0, limit + 1);
    const newline = window.lastIndexOf("\n");
    const space = window.lastIndexOf(" ");
    // Without whitespace in the window (base64, long URLs) fall back to a hard
    // cut at the limit instead of degenerating to one-character chunks.
    let splitAt = Math.max(newline, space);
    if (splitAt < 1) splitAt = limit;
    const chunk = remaining.slice(0, splitAt).trim();
    if (chunk) chunks.push(chunk);
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
