import { createHash } from "node:crypto";
import { z } from "zod";

import { isValidTimeZone } from "../../shared/src/index.js";

const calendarBoundarySchema = z.object({
  dateTime: z.string().optional(),
  date: z.string().optional(),
  timeZone: z.string().optional(),
}).refine((value) => Boolean(value.dateTime || value.date), {
  message: "calendar boundary requires dateTime or date",
});

const calendarEventSchema = z.object({
  id: z.string(),
  summary: z.string().optional(),
  description: z.string().optional(),
  location: z.string().optional(),
  htmlLink: z.string().url().optional(),
  start: calendarBoundarySchema,
  end: calendarBoundarySchema,
});

const gmailListSchema = z.object({
  messages: z.array(z.object({ id: z.string(), threadId: z.string().optional() })).optional(),
});

const gmailMessageSchema = z.object({
  id: z.string(),
  threadId: z.string().optional(),
  snippet: z.string().optional(),
  internalDate: z.string().optional(),
  payload: z.object({
    headers: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
  }).optional(),
});

export interface GoogleWorkspaceConnectorOptions {
  accessToken?: string;
  calendarId?: string;
  gmailUserId?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * One calendar event as the tool layer sees it. Declared rather than
 * `Record<string, unknown>` so the fencing call site names real fields: a typo
 * in the fenced-field list is then a compile error, not a silent hole.
 * Prose fields (`title`, `description`, `location`) are written by whoever
 * could put an entry on the calendar and must be fenced before an LLM sees
 * them; ids, times and URLs stay machine-readable.
 */
export interface CalendarEventRow {
  id: string;
  title: string;
  start?: string | undefined;
  end?: string | undefined;
  location?: string | undefined;
  description?: string | undefined;
  url?: string | undefined;
}

/**
 * A page of events plus what it cost to read it.
 *
 * `skipped` exists so the agent is never quietly told a half-truth. The
 * previous code parsed the page with `z.array(calendarEventSchema)`, which is
 * atomic: one cancelled instance without a `start` block, or one `htmlLink`
 * that failed `z.string().url()`, threw — and nine good events became "the
 * calendar is broken" (audit finding). Skipping the broken row is only an
 * improvement if the count travels with the answer; otherwise "you have
 * nothing today" and "you have nothing today that I could parse" look alike.
 */
export interface CalendarEventListing {
  events: CalendarEventRow[];
  /** Items the API returned that did not parse and were left out. */
  skipped: number;
}

/** Result of a create, with the idempotency key the caller may reuse. */
export interface CalendarEventCreation {
  id: string;
  title?: string | undefined;
  start?: string | undefined;
  end?: string | undefined;
  url?: string | undefined;
  /** True when the event already existed under this key and was not re-created. */
  duplicate: boolean;
}

/** A Google response the caller may need to branch on (409 = id taken). */
export class GoogleWorkspaceHttpError extends Error {
  constructor(readonly status: number) {
    super(`Google Workspace request failed (${status})`);
    this.name = "GoogleWorkspaceHttpError";
  }
}

/**
 * One Gmail message as the tool layer sees it. Address and display name are
 * split deliberately: `fromAddress`/`toAddress` are validated bare addresses
 * (raw, reusable by email.send), `fromName`/`toName`/`subject`/`snippet` are
 * attacker-written prose and must be fenced. `date` is normalized to ISO.
 */
export interface EmailMessageRow {
  id: string;
  threadId?: string | undefined;
  fromAddress?: string;
  fromName?: string;
  toAddress?: string;
  toName?: string;
  subject?: string;
  date?: string;
  snippet?: string;
}

export class GoogleWorkspaceConnectors {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: GoogleWorkspaceConnectorOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  availability(): { calendar: boolean; email: boolean } {
    return {
      calendar: Boolean(this.options.accessToken && this.options.calendarId),
      email: Boolean(this.options.accessToken && this.options.gmailUserId),
    };
  }

  async listCalendarEvents(input: {
    timeMin: string;
    timeMax?: string;
    query?: string;
    limit?: number;
  }): Promise<CalendarEventListing> {
    this.requireCalendar();
    const timeMin = parseInstant(input.timeMin, "timeMin");
    const timeMax = input.timeMax ? parseInstant(input.timeMax, "timeMax") : undefined;
    if (timeMax && timeMax.getTime() <= timeMin.getTime()) {
      throw new Error("calendar event timeMax must be after timeMin");
    }
    const url = new URL(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(this.options.calendarId!)}/events`,
    );
    url.searchParams.set("timeMin", timeMin.toISOString());
    if (timeMax) url.searchParams.set("timeMax", timeMax.toISOString());
    if (input.query) url.searchParams.set("q", input.query.slice(0, 500));
    url.searchParams.set("singleEvents", "true");
    url.searchParams.set("orderBy", "startTime");
    url.searchParams.set("maxResults", String(Math.min(50, Math.max(1, input.limit ?? 10))));
    // The ENVELOPE is still parsed strictly — a response with no `items` array
    // is a different failure from a response with one bad item in it, and
    // silently reading zero events out of a 500 page would be the worst
    // outcome available. Only the items are parsed one at a time.
    const payload = z.object({ items: z.array(z.unknown()).optional() }).parse(
      await this.requestJson(url),
    );
    const events: CalendarEventRow[] = [];
    let skipped = 0;
    for (const item of payload.items ?? []) {
      const parsed = calendarEventSchema.safeParse(item);
      if (!parsed.success) {
        skipped += 1;
        continue;
      }
      const event = parsed.data;
      events.push({
        id: event.id,
        title: event.summary ?? "(untitled)",
        start: event.start.dateTime ?? event.start.date,
        end: event.end.dateTime ?? event.end.date,
        ...(event.location ? { location: event.location } : {}),
        ...(event.description ? { description: event.description.slice(0, 1_000) } : {}),
        ...(event.htmlLink ? { url: event.htmlLink } : {}),
      });
    }
    return { events, skipped };
  }

  /**
   * Create an event that a retry cannot duplicate.
   *
   * Two audit findings meet here. The write used to be the ARGUMENT of
   * `calendarEventSchema.parse(...)`, so a differently-shaped response threw
   * *after* the event existed: the agent read an error, retried, and the owner
   * got the meeting twice. Both halves are addressed:
   *
   *  - everything checkable is checked BEFORE the request (title, both
   *    instants, their order, the zone, the attendees) — a bad argument now
   *    fails without writing anything;
   *  - the event id is OURS, derived from the request, so the retry is a
   *    no-op. Google's `events.insert` accepts a caller-supplied id and
   *    answers 409 when it is taken; that 409 is the success path of a second
   *    attempt, not an error, and the existing event is fetched and returned.
   *
   * The response is then parsed leniently, because by that point the write has
   * happened and refusing to report it is precisely the bug. The id is known
   * regardless of what came back.
   */
  async createCalendarEvent(input: {
    title: string;
    start: string;
    end: string;
    timeZone?: string;
    description?: string;
    location?: string;
    attendees?: string[];
    /**
     * Distinguishes two deliberately identical events. Defaults to the request
     * itself, which is what makes a blind retry idempotent; pass something
     * unique to book the same slot twice on purpose.
     */
    idempotencyKey?: string;
  }): Promise<CalendarEventCreation> {
    this.requireCalendar();
    const title = input.title.trim().slice(0, 500);
    if (!title) throw new Error("calendar event title is empty");
    const start = parseInstant(input.start, "start");
    const end = parseInstant(input.end, "end");
    if (end.getTime() <= start.getTime()) {
      throw new Error("calendar event end must be after its start");
    }
    if (input.timeZone && !isValidTimeZone(input.timeZone)) {
      // Not resolved to a fallback: the zone decides what the owner sees in
      // their calendar, and quietly writing UTC over a typo would put a 09:00
      // meeting at the wrong hour with no error to notice.
      throw new Error(`Unknown IANA time zone: ${input.timeZone}`);
    }
    const attendees = (input.attendees ?? []).slice(0, 50).map((email) => validateEmail(email));

    const eventId = calendarEventId(
      input.idempotencyKey ??
        [
          this.options.calendarId ?? "",
          title,
          start.toISOString(),
          end.toISOString(),
          input.timeZone ?? "",
          input.description ?? "",
          input.location ?? "",
          attendees.join(","),
        ].join("\\u0000"),
    );
    const body = JSON.stringify({
      id: eventId,
      summary: title,
      start: { dateTime: start.toISOString(), ...(input.timeZone ? { timeZone: input.timeZone } : {}) },
      end: { dateTime: end.toISOString(), ...(input.timeZone ? { timeZone: input.timeZone } : {}) },
      ...(input.description ? { description: input.description.slice(0, 8_000) } : {}),
      ...(input.location ? { location: input.location.slice(0, 1_000) } : {}),
      ...(attendees.length ? { attendees: attendees.map((email) => ({ email })) } : {}),
    });
    const url = new URL(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(this.options.calendarId!)}/events`,
    );
    let duplicate = false;
    let response: unknown;
    try {
      response = await this.requestJson(url, { method: "POST", body });
    } catch (error) {
      if (!(error instanceof GoogleWorkspaceHttpError) || error.status !== 409) throw error;
      duplicate = true;
      const existing = new URL(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(this.options.calendarId!)}/events/${encodeURIComponent(eventId)}`,
      );
      // A 409 says the id is taken, which is exactly what the previous attempt
      // was supposed to achieve. Reading it back keeps the return shape honest;
      // if even that fails, the id alone is still a truthful answer.
      response = await this.requestJson(existing).catch(() => undefined);
    }
    const parsed = calendarEventSchema.safeParse(response);
    if (!parsed.success) {
      return { id: eventId, title, start: start.toISOString(), end: end.toISOString(), duplicate };
    }
    const event = parsed.data;
    return {
      id: event.id,
      title: event.summary ?? title,
      start: event.start.dateTime ?? event.start.date,
      end: event.end.dateTime ?? event.end.date,
      ...(event.htmlLink ? { url: event.htmlLink } : {}),
      duplicate,
    };
  }

  async searchEmail(input: { query: string; limit?: number }): Promise<EmailMessageRow[]> {
    this.requireEmail();
    const limit = Math.min(10, Math.max(1, input.limit ?? 5));
    const listUrl = new URL(
      `https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(this.options.gmailUserId!)}/messages`,
    );
    listUrl.searchParams.set("q", input.query.slice(0, 1_000));
    listUrl.searchParams.set("maxResults", String(limit));
    const listed = gmailListSchema.parse(await this.requestJson(listUrl));
    return Promise.all((listed.messages ?? []).slice(0, limit).map(async ({ id }) => {
      const messageUrl = new URL(
        `https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(this.options.gmailUserId!)}/messages/${encodeURIComponent(id)}`,
      );
      messageUrl.searchParams.set("format", "metadata");
      for (const header of ["From", "To", "Subject", "Date"]) messageUrl.searchParams.append("metadataHeaders", header);
      const message = gmailMessageSchema.parse(await this.requestJson(messageUrl));
      const headers = Object.fromEntries(
        (message.payload?.headers ?? []).map((header) => [header.name.toLocaleLowerCase(), header.value.slice(0, 1_000)]),
      );
      // The whole header is attacker-written. Split each address header into a
      // bare validated address (machine-readable, safe to feed back to
      // email.send) and a display name (free prose, fenced by the tool layer),
      // and normalize the date instead of forwarding up to 1 000 raw characters.
      const from = splitAddressHeader(headers.from);
      const to = splitAddressHeader(headers.to);
      const date = normalizeHeaderDate(headers.date, message.internalDate);
      return {
        id: message.id,
        threadId: message.threadId,
        ...(from.address ? { fromAddress: from.address } : {}),
        ...(from.name ? { fromName: from.name } : {}),
        ...(to.address ? { toAddress: to.address } : {}),
        ...(to.name ? { toName: to.name } : {}),
        ...(headers.subject ? { subject: headers.subject } : {}),
        ...(date ? { date } : {}),
        ...(message.snippet ? { snippet: message.snippet.slice(0, 2_000) } : {}),
      };
    }));
  }

  async sendEmail(input: {
    to: string[];
    subject: string;
    text: string;
    cc?: string[];
  }): Promise<Record<string, unknown>> {
    this.requireEmail();
    const to = input.to.slice(0, 50).map(validateEmail);
    const cc = (input.cc ?? []).slice(0, 50).map(validateEmail);
    if (!to.length) throw new Error("at least one recipient is required");
    const subject = rejectHeaderInjection(input.subject).slice(0, 998);
    const mime = [
      `To: ${to.join(", ")}`,
      ...(cc.length ? [`Cc: ${cc.join(", ")}`] : []),
      `Subject: ${subject}`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: 8bit",
      "",
      input.text.slice(0, 100_000),
    ].join("\r\n");
    const raw = Buffer.from(mime, "utf8").toString("base64url");
    const url = new URL(
      `https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(this.options.gmailUserId!)}/messages/send`,
    );
    const sent = gmailMessageSchema.pick({ id: true, threadId: true }).parse(
      await this.requestJson(url, { method: "POST", body: JSON.stringify({ raw }) }),
    );
    return sent;
  }

  private requireCalendar(): void {
    if (!this.availability().calendar) throw new Error("Google Calendar connector is not configured");
  }

  private requireEmail(): void {
    if (!this.availability().email) throw new Error("Gmail connector is not configured");
  }

  private async requestJson(url: URL, init: RequestInit = {}): Promise<unknown> {
    const response = await this.fetchImpl(url, {
      ...init,
      headers: {
        authorization: `Bearer ${this.options.accessToken}`,
        accept: "application/json",
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    // Typed so a caller can branch on the status — the calendar create reads a
    // 409 as "the previous attempt already landed", not as a failure.
    if (!response.ok) throw new GoogleWorkspaceHttpError(response.status);
    return response.json();
  }
}

/**
 * A Google Calendar event id derived from the request.
 *
 * The API's id grammar is base32hex — digits and `a`–`v`, 5..1024 characters —
 * and a hex digest is a strict subset of it, so the digest is usable verbatim.
 */
function calendarEventId(seed: string): string {
  return createHash("sha256").update(seed, "utf8").digest("hex");
}

/** Parse an instant, naming the argument — these strings come from the model. */
function parseInstant(value: string, field: string): Date {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error(`calendar event ${field} is not a valid date-time`);
  }
  return parsed;
}

/**
 * Split `"Ада Лавлейс" <ada@example.com>` into a bare address and a display
 * name. The address is validated, so it stays raw and machine-readable and can
 * be handed straight back to email.send; the name is free prose an outsider
 * chose, and the tool layer fences it. An unparseable header yields no address
 * and keeps the whole string as the name, which is the safe direction.
 */
function splitAddressHeader(header: string | undefined): { address?: string; name?: string } {
  const value = (header ?? "").trim();
  if (!value) return {};
  const angled = /^(.*)<([^<>]+)>\s*$/s.exec(value);
  const candidate = (angled?.[2] ?? value).trim();
  const name = (angled?.[1] ?? "").trim().replace(/^"(.*)"$/s, "$1").trim();
  let address: string | undefined;
  try {
    address = validateEmail(candidate);
  } catch {
    address = undefined;
  }
  return {
    ...(address ? { address } : {}),
    // Without a parsed address the raw header is all the caller gets; label it
    // as the name so it travels through the fenced path rather than the raw one.
    ...(name ? { name } : address ? {} : { name: value }),
  };
}

/**
 * Header dates are attacker-written strings. Normalize to ISO, and drop the
 * field entirely when it does not parse rather than forwarding raw prose.
 */
function normalizeHeaderDate(header: string | undefined, internalDate: string | undefined): string | undefined {
  for (const candidate of [header, internalDate ? Number(internalDate) : undefined]) {
    if (candidate === undefined || candidate === "") continue;
    const parsed = new Date(candidate);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return undefined;
}

function validateEmail(value: string): string {
  const email = rejectHeaderInjection(value.trim());
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("invalid email address");
  return email;
}

function rejectHeaderInjection(value: string): string {
  if (/\r|\n/.test(value)) throw new Error("email header contains a newline");
  return value;
}
