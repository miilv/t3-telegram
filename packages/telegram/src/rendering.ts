const LEGACY_SAFE_LIMIT = 4000;
export const RICH_SAFE_LIMIT = 30_000;

export function splitRichText(text: string, limit = LEGACY_SAFE_LIMIT): string[] {
  if (text.length <= limit) return [text];
  const segments = tokenizeFencedBlocks(text);
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
    } else {
      const plainChunks = splitPlainText(segment, limit);
      chunks.push(...plainChunks.slice(0, -1));
      current = plainChunks.at(-1) ?? "";
    }
  }
  if (current) chunks.push(current);
  return chunks;
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
    const splitAt = Math.max(newline, space, 1);
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
