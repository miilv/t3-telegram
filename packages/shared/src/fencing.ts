/**
 * Structural fencing for untrusted content on its way into an LLM prompt
 * (bug №9, roadmap 0.5).
 *
 * A fence is `<<<label:nonce>>> … <<<end:nonce>>>` with a fresh random nonce
 * per call. Three properties have to hold at once, and each one is a separate
 * defence here:
 *
 * 1. Content cannot forge its own terminator — the nonce is unpredictable.
 * 2. Content cannot open OR close a fence at all: every marker-shaped sequence
 *    in it is defanged before it goes inside. Without this, an attacker's
 *    unclosed opening marker survives into the prompt, and a later repair pass
 *    (or the model itself) can treat everything after it as freshly opened.
 * 3. Truncation cannot drop a terminator — `truncateFenceAware` re-closes only
 *    the fences WE opened, within a reserved budget, so a marker-stuffed
 *    payload cannot inflate a result past its cap.
 */

export const UNTRUSTED_LABELS = ["inbound", "worker", "tool"] as const;

/**
 * Provenance labels. `inbound` is the owner's own message, `worker` is anything
 * a T3 worker wrote, `tool` is anything a tool result carried in from outside.
 * Every member must also be described to the model — see the label contract
 * test in tests/fencing.test.ts.
 */
export type UntrustedLabel = (typeof UNTRUSTED_LABELS)[number];

const NONCE_HEX_LENGTH = 8;
const OPEN_MARKER = new RegExp(`<<<(${UNTRUSTED_LABELS.join("|")}):([0-9a-f]{${NONCE_HEX_LENGTH}})>>>`, "g");
const CLOSE_MARKER = new RegExp(`<<<end:([0-9a-f]{${NONCE_HEX_LENGTH}})>>>`, "g");
/**
 * Deliberately loose: anything the model could read as fence vocabulary gets
 * defanged, not just well-formed markers. The model does not parse hex.
 */
const MARKER_SHAPED = /<<<[^<>\n]{0,64}>>>/g;
/** A zero-width non-joiner between the angles: still readable, no longer a marker. */
const ZWNJ = "‌";

const CLOSE_MARKER_LENGTH = `<<<end:${"0".repeat(NONCE_HEX_LENGTH)}>>>`.length + 1;

/**
 * The nonces this process has issued. `truncateFenceAware` re-closes only these:
 * closing a marker an attacker wrote would hand them a terminator inside the
 * trusted zone, and would let them spend our length budget on repairs.
 * Bounded FIFO — a nonce is only interesting for the lifetime of one call.
 */
const MAX_TRACKED_NONCES = 512;
const issuedNonces = new Set<string>();

function rememberNonce(nonce: string): void {
  issuedNonces.add(nonce);
  // Sets iterate in insertion order, so the first entry is the oldest.
  while (issuedNonces.size > MAX_TRACKED_NONCES) {
    const oldest = issuedNonces.values().next();
    if (oldest.done) break;
    issuedNonces.delete(oldest.value);
  }
}

/** Every fence nonce still tracked; pass this to the truncation helpers. */
export function knownFenceNonces(): ReadonlySet<string> {
  return issuedNonces;
}

function randomNonce(): string {
  // Web Crypto, never Math.random: the whole scheme rests on this being
  // unpredictable to whoever wrote the content being fenced.
  return [...crypto.getRandomValues(new Uint8Array(NONCE_HEX_LENGTH / 2))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Neutralize every marker-shaped sequence so fenced content cannot speak fence. */
export function defangMarkers(content: string): string {
  return content.replace(
    MARKER_SHAPED,
    (marker) => `<${ZWNJ}<${ZWNJ}<${marker.slice(3, -3)}>${ZWNJ}>${ZWNJ}>`,
  );
}

export interface Fence {
  (content: string): string;
  /** The marker nonce shared by every field this fence wraps. */
  readonly nonce: string;
  readonly label: UntrustedLabel;
}

/**
 * Open one fence for one call. The returned wrapper may be reused across every
 * untrusted field of that call: they share ONE marker, so the model sees a
 * single fence vocabulary and no field can close a sibling's fence.
 */
export function openFence(label: UntrustedLabel): Fence {
  const nonce = randomNonce();
  rememberNonce(nonce);
  const fence = (content: string): string =>
    `<<<${label}:${nonce}>>>\n${defangMarkers(content)}\n<<<end:${nonce}>>>`;
  return Object.assign(fence, { nonce, label }) as Fence;
}

/** Single-shot fence for one standalone blob. */
export function fenceUntrusted(content: string, label: UntrustedLabel): string {
  return openFence(label)(content);
}

interface MarkerHit {
  index: number;
  nonce: string;
  kind: "open" | "close";
}

function scanMarkers(text: string): MarkerHit[] {
  const hits: MarkerHit[] = [];
  for (const match of text.matchAll(OPEN_MARKER)) {
    hits.push({ index: match.index, nonce: match[2]!, kind: "open" });
  }
  for (const match of text.matchAll(CLOSE_MARKER)) {
    hits.push({ index: match.index, nonce: match[1]!, kind: "close" });
  }
  return hits.sort((left, right) => left.index - right.index);
}

/**
 * Nonces opened in `text` and never closed AFTER the opening position. Order of
 * appearance is preserved. A close that precedes its open does not count — it
 * belongs to no fence and repairing against it would leave the real one open.
 */
function danglingNonces(text: string, known: ReadonlySet<string>): string[] {
  const open: string[] = [];
  for (const hit of scanMarkers(text)) {
    if (!known.has(hit.nonce)) continue;
    if (hit.kind === "open") {
      if (!open.includes(hit.nonce)) open.push(hit.nonce);
    } else {
      const position = open.indexOf(hit.nonce);
      if (position >= 0) open.splice(position, 1);
    }
  }
  return open;
}

/**
 * Close every fence WE opened in `text` and left open. Unknown markers are left
 * exactly as they are: they are somebody else's text, not a fence.
 */
export function closeDanglingFences(text: string, knownNonces: Iterable<string>): string {
  const dangling = danglingNonces(text, new Set(knownNonces));
  if (dangling.length === 0) return text;
  // Innermost first, so nested fences close in the order they were opened.
  return [text, ...[...dangling].reverse().map((nonce) => `<<<end:${nonce}>>>`)].join("\n");
}

/**
 * The single truncation path for fenced text: never returns more than `limit`
 * characters and never leaves one of our fences open.
 *
 * The repair budget is reserved UP FRONT from the limit, using the distinct
 * known nonces present in the widest slice we might keep. Shrinking a slice can
 * turn a closed pair into a dangling open, but it can never introduce a nonce
 * that was not already there — so that count is a true upper bound, and the
 * result cannot exceed `limit` no matter how many markers the payload carries.
 */
export function truncateFenceAware(
  text: string,
  limit: number,
  knownNonces: Iterable<string>,
  ellipsis = "…",
): string {
  if (text.length <= limit) return text;
  if (limit <= 0) return "";
  const known = new Set(knownNonces);
  const widest = text.slice(0, limit);
  const present = new Set(
    scanMarkers(widest).map((hit) => hit.nonce).filter((nonce) => known.has(nonce)),
  );
  // The ellipsis is a courtesy, not a guarantee: drop it rather than exceed the cap.
  const suffix = ellipsis.length <= limit ? ellipsis : "";
  const budget = Math.max(0, limit - suffix.length - present.size * CLOSE_MARKER_LENGTH);
  return closeDanglingFences(`${text.slice(0, budget)}${suffix}`, known);
}
