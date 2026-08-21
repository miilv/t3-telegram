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
  }): Promise<Array<Record<string, unknown>>> {
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

  async searchEmail(input: { query: string; limit?: number }): Promise<Array<Record<string, unknown>>> {
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
      return {
        id: message.id,
        threadId: message.threadId,
        from: headers.from,
        to: headers.to,
        subject: headers.subject,
        date: headers.date ?? (message.internalDate ? new Date(Number(message.internalDate)).toISOString() : undefined),
        snippet: message.snippet?.slice(0, 2_000),
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

function validateEmail(value: string): string {
  const email = rejectHeaderInjection(value.trim());
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("invalid email address");
  return email;
}

function rejectHeaderInjection(value: string): string {
  if (/\r|\n/.test(value)) throw new Error("email header contains a newline");
  return value;
}
