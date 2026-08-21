import { describe, expect, it } from "vitest";
import { GoogleWorkspaceConnectors } from "../packages/connectors/src/index.js";

describe("GoogleWorkspaceConnectors", () => {
  it("uses the official bounded Calendar and Gmail REST contracts", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const connector = new GoogleWorkspaceConnectors({
      accessToken: "secret-access-token",
      calendarId: "primary",
      gmailUserId: "me",
      fetchImpl: async (input, init) => {
        const url = String(input);
        requests.push({ url, ...(init ? { init } : {}) });
        if (url.includes("calendar") && init?.method === "POST") {
          return Response.json({
            id: "event_1",
            summary: "Review",
            htmlLink: "https://calendar.google.com/event?eid=1",
            start: { dateTime: "2026-08-21T10:00:00.000Z" },
            end: { dateTime: "2026-08-21T10:30:00.000Z" },
          });
        }
        if (url.includes("calendar")) {
          return Response.json({ items: [{
            id: "event_1",
            summary: "Review",
            start: { dateTime: "2026-08-21T10:00:00Z" },
            end: { dateTime: "2026-08-21T10:30:00Z" },
          }] });
        }
        if (url.includes("/messages?q=is%3Aunread&maxResults=")) {
          return Response.json({ messages: [{ id: "mail_1", threadId: "gmail_thread_1" }] });
        }
        if (url.includes("/messages/mail_1")) {
          return Response.json({
            id: "mail_1",
            threadId: "gmail_thread_1",
            snippet: "Please review",
            payload: { headers: [{ name: "From", value: "a@example.com" }, { name: "Subject", value: "Review" }] },
          });
        }
        if (url.endsWith("/messages/send")) return Response.json({ id: "sent_1", threadId: "gmail_thread_2" });
        throw new Error(`unexpected request ${url}`);
      },
    });

    expect(await connector.listCalendarEvents({ timeMin: "2026-08-21T00:00:00Z" })).toMatchObject([{ id: "event_1", title: "Review" }]);
    expect(await connector.createCalendarEvent({
      title: "Review",
      start: "2026-08-21T10:00:00Z",
      end: "2026-08-21T10:30:00Z",
    })).toMatchObject({ id: "event_1" });
    expect(await connector.searchEmail({ query: "is:unread", limit: 2 })).toMatchObject([{ id: "mail_1", subject: "Review" }]);
    expect(await connector.sendEmail({ to: ["b@example.com"], subject: "Status", text: "Done" })).toEqual({ id: "sent_1", threadId: "gmail_thread_2" });
    expect(requests.every((request) => new Headers(request.init?.headers).get("authorization") === "Bearer secret-access-token")).toBe(true);
    const sentBody = JSON.parse(String(requests.find((request) => request.url.endsWith("/messages/send"))?.init?.body)) as { raw: string };
    expect(Buffer.from(sentBody.raw, "base64url").toString("utf8")).toContain("Subject: Status\r\n");
    expect(JSON.stringify(await connector.searchEmail({ query: "is:unread", limit: 1 }))).not.toContain("secret-access-token");
  });

  it("rejects missing credentials and email header injection", async () => {
    const disabled = new GoogleWorkspaceConnectors({});
    await expect(disabled.listCalendarEvents({ timeMin: new Date().toISOString() })).rejects.toThrow("not configured");
    const enabled = new GoogleWorkspaceConnectors({
      accessToken: "token",
      calendarId: "primary",
      gmailUserId: "me",
      fetchImpl: async () => Response.json({}),
    });
    await expect(enabled.sendEmail({ to: ["x@example.com\nBcc:evil@example.com"], subject: "x", text: "x" })).rejects.toThrow("newline");
  });
});
