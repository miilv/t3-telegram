import { z } from "zod";

const calendarEventSchema = z.object({
  id: z.string(),
  summary: z.string().optional(),
  description: z.string().optional(),
  location: z.string().optional(),
  htmlLink: z.string().url().optional(),
  start: z.object({ dateTime: z.string().optional(), date: z.string().optional(), timeZone: z.string().optional() }),
  end: z.object({ dateTime: z.string().optional(), date: z.string().optional(), timeZone: z.string().optional() }),
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
  }): Promise<CalendarEventRow[]> {
    this.requireCalendar();
    const url = new URL(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(this.options.calendarId!)}/events`,
    );
    url.searchParams.set("timeMin", new Date(input.timeMin).toISOString());
    if (input.timeMax) url.searchParams.set("timeMax", new Date(input.timeMax).toISOString());
    if (input.query) url.searchParams.set("q", input.query.slice(0, 500));
    url.searchParams.set("singleEvents", "true");
    url.searchParams.set("orderBy", "startTime");
    url.searchParams.set("maxResults", String(Math.min(50, Math.max(1, input.limit ?? 10))));
    const payload = z.object({ items: z.array(calendarEventSchema).optional() }).parse(await this.requestJson(url));
    return (payload.items ?? []).map((event) => ({
      id: event.id,
      title: event.summary ?? "(untitled)",
      start: event.start.dateTime ?? event.start.date,
      end: event.end.dateTime ?? event.end.date,
      ...(event.location ? { location: event.location } : {}),
      ...(event.description ? { description: event.description.slice(0, 1_000) } : {}),
      ...(event.htmlLink ? { url: event.htmlLink } : {}),
    }));
  }

  async createCalendarEvent(input: {
    title: string;
    start: string;
    end: string;
    timeZone?: string;
    description?: string;
    location?: string;
    attendees?: string[];
  }): Promise<Record<string, unknown>> {
    this.requireCalendar();
    const url = new URL(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(this.options.calendarId!)}/events`,
    );
    const event = calendarEventSchema.parse(await this.requestJson(url, {
      method: "POST",
      body: JSON.stringify({
        summary: input.title.slice(0, 500),
        start: { dateTime: new Date(input.start).toISOString(), ...(input.timeZone ? { timeZone: input.timeZone } : {}) },
        end: { dateTime: new Date(input.end).toISOString(), ...(input.timeZone ? { timeZone: input.timeZone } : {}) },
        ...(input.description ? { description: input.description.slice(0, 8_000) } : {}),
        ...(input.location ? { location: input.location.slice(0, 1_000) } : {}),
        ...(input.attendees?.length
          ? { attendees: input.attendees.slice(0, 50).map((email) => ({ email: validateEmail(email) })) }
          : {}),
      }),
    }));
    return { id: event.id, title: event.summary, start: event.start.dateTime, end: event.end.dateTime, url: event.htmlLink };
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
    if (!response.ok) throw new Error(`Google Workspace request failed (${response.status})`);
    return response.json();
  }
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
