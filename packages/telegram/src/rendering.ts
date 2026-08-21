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
  const tail = "\n\n… _stream continues_";
  let preview = text.slice(text.length - Math.max(1, limit - tail.length));
  const firstLineBreak = preview.indexOf("\n");
  if (firstLineBreak > 0 && firstLineBreak < 300) preview = preview.slice(firstLineBreak + 1);
  return `${tail.trimStart()}\n\n${preview}`.slice(-limit);
}

export function renderStreamPhase(phase: "thinking" | "tools" | "text", text: string): string {
  if (phase === "text") return text;
  const title = phase === "thinking" ? "Thinking" : "Tool activity";
  // Keep math outside details: some Telegram Desktop builds have crashed on
  // math nested in a details block (Hermes Agent production guard).
  if (/\$\$|```math|<tg-math/i.test(text)) return `### ${title}\n\n${text}`;
  return `<details><summary>${title}</summary>\n\n${text}\n\n</details>`;
}

export function markdownToTelegramHtml(markdown: string): string {
  const codeBlocks: string[] = [];
  let value = markdown.replace(/```(?:[\w+-]+)?\n?([\s\S]*?)```/g, (_match, code: string) => {
    const token = `@@CODEBLOCK${codeBlocks.length}@@`;
    codeBlocks.push(`<pre><code>${escapeHtml(code.trimEnd())}</code></pre>`);
    return token;
  });
  value = escapeHtml(value)
    .replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>")
    .replace(/^&gt;\s?(.+)$/gm, "<blockquote>$1</blockquote>")
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/__(.+?)__/g, "<b>$1</b>")
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\[([^\]]+)]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
  codeBlocks.forEach((block, index) => {
    value = value.replace(`@@CODEBLOCK${index}@@`, block);
  });
  return value;
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
