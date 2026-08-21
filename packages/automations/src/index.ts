import type { Automation, AutomationSchedule } from "../../shared/src/index.js";
import { newId } from "../../shared/src/index.js";

export function createAutomation(input: {
  ownerId: string;
  name: string;
  prompt: string;
  schedule: AutomationSchedule;
  chatId: number;
  messageThreadId?: number;
  directMessagesTopicId?: number;
  projectId?: string;
  now?: Date;
}): Automation {
  const now = input.now ?? new Date();
  const timestamp = now.toISOString();
  return {
    id: newId("automation"),
    ownerId: input.ownerId,
    name: input.name.trim().slice(0, 160),
    prompt: input.prompt.trim().slice(0, 64_000),
    schedule: input.schedule,
    chatId: input.chatId,
    status: "active",
    nextRunAt: firstAutomationRun(input.schedule, now),
    createdAt: timestamp,
    updatedAt: timestamp,
    ...(input.messageThreadId ? { messageThreadId: input.messageThreadId } : {}),
    ...(input.directMessagesTopicId ? { directMessagesTopicId: input.directMessagesTopicId } : {}),
    ...(input.projectId ? { projectId: input.projectId } : {}),
  };
}

export function firstAutomationRun(schedule: AutomationSchedule, now = new Date()): string {
  if (schedule.type === "once") {
    const runAt = new Date(schedule.runAt);
    if (!Number.isFinite(runAt.getTime())) throw new Error("once schedule requires an ISO date-time");
    return runAt.toISOString();
  }
  if (schedule.type === "interval") {
    if (!Number.isInteger(schedule.intervalMinutes) || schedule.intervalMinutes < 1) {
      throw new Error("interval schedule requires at least one minute");
    }
    return new Date(now.getTime() + schedule.intervalMinutes * 60_000).toISOString();
  }
  return nextDailyOccurrence(schedule.timeOfDay, schedule.timeZone, now).toISOString();
}

export function nextAutomationRun(
  schedule: AutomationSchedule,
  scheduledFor: string,
  now = new Date(),
): string | undefined {
  if (schedule.type === "once") return undefined;
  if (schedule.type === "interval") {
    const intervalMs = schedule.intervalMinutes * 60_000;
    let next = Date.parse(scheduledFor) + intervalMs;
    while (next <= now.getTime()) next += intervalMs;
    return new Date(next).toISOString();
  }
  return nextDailyOccurrence(schedule.timeOfDay, schedule.timeZone, now).toISOString();
}

export function parseAutomationSchedule(input: string): AutomationSchedule {
  const normalized = input.trim();
  const once = /^once\s+(.+)$/iu.exec(normalized);
  if (once) {
    const parsed = new Date(once[1]!);
    if (!Number.isFinite(parsed.getTime())) throw new Error("invalid once date-time");
    return { type: "once", runAt: parsed.toISOString() };
  }
  const interval = /^(?:every|interval)\s+(\d+)(?:m|min|minutes?)?$/iu.exec(normalized);
  if (interval) {
    const intervalMinutes = Number(interval[1]);
    if (intervalMinutes < 1 || intervalMinutes > 525_600) throw new Error("interval must be 1..525600 minutes");
    return { type: "interval", intervalMinutes };
  }
  const daily = /^daily\s+([01]\d|2[0-3]):([0-5]\d)(?:\s+(.+))?$/iu.exec(normalized);
  if (daily) {
    const timeZone = daily[3]?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    assertTimeZone(timeZone);
    return { type: "daily", timeOfDay: `${daily[1]}:${daily[2]}`, timeZone };
  }
  throw new Error("schedule must be `once <ISO>`, `every <minutes>`, or `daily HH:MM [IANA timezone]`");
}

function nextDailyOccurrence(timeOfDay: string, timeZone: string, after: Date): Date {
  assertTimeZone(timeZone);
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(timeOfDay);
  if (!match) throw new Error("daily time must use HH:MM");
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const local = zonedParts(after, timeZone);
  let candidate = zonedDateToUtc(local.year, local.month, local.day, hour, minute, timeZone);
  if (candidate.getTime() <= after.getTime()) {
    const noon = new Date(Date.UTC(local.year, local.month - 1, local.day, 12));
    noon.setUTCDate(noon.getUTCDate() + 1);
    candidate = zonedDateToUtc(
      noon.getUTCFullYear(),
      noon.getUTCMonth() + 1,
      noon.getUTCDate(),
      hour,
      minute,
      timeZone,
    );
  }
  return candidate;
}

function zonedDateToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const wallClock = Date.UTC(year, month - 1, day, hour, minute);
  let candidate = wallClock;
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const offset = timeZoneOffsetMs(new Date(candidate), timeZone);
    const adjusted = wallClock - offset;
    if (adjusted === candidate) break;
    candidate = adjusted;
  }
  return new Date(candidate);
}

function timeZoneOffsetMs(date: Date, timeZone: string): number {
  const parts = zonedParts(date, timeZone);
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) -
    Math.floor(date.getTime() / 1_000) * 1_000;
}

function zonedParts(date: Date, timeZone: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const values = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]),
  );
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
  };
}

function assertTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat("en", { timeZone }).format(new Date());
  } catch {
    throw new Error("invalid IANA timezone");
  }
}

export function automationScheduleLabel(schedule: AutomationSchedule): string {
  if (schedule.type === "once") return `once ${schedule.runAt}`;
  if (schedule.type === "interval") return `every ${schedule.intervalMinutes} min`;
  return `daily ${schedule.timeOfDay} ${schedule.timeZone}`;
}
