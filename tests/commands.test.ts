import { describe, expect, it } from "vitest";
import {
  COMMAND_PAGE_SIZE,
  OPERATOR_COMMANDS,
  commandNameOf,
  dispatchableCommandName,
  editDistance,
  isViewerSafeMessage,
  paginateCommandList,
  parseCommandPage,
  renderHelp,
  suggestCommand,
  telegramCommandMenu,
  unknownCommandReply,
  viewerWallText,
} from "../apps/daemon/src/commands.js";

/** Commands package 1.3 deleted; none of them may come back through the table. */
const RETIRED = ["stop", "cancel", "focus"];

describe("command catalogue (package 4.3)", () => {
  it("publishes a Telegram-legal menu that carries nothing package 1.3 deleted", () => {
    for (const role of ["viewer", "member", "admin", "owner"] as const) {
      const menu = telegramCommandMenu(role);
      expect(menu.length).toBeGreaterThan(0);
      for (const entry of menu) {
        // Bot API: 1–32 chars, lowercase ASCII letters, digits and underscores.
        expect(entry.command).toMatch(/^[a-z0-9_]{1,32}$/u);
        expect(entry.description.length).toBeGreaterThan(0);
        expect(entry.description.length).toBeLessThanOrEqual(256);
        expect(RETIRED).not.toContain(entry.command);
      }
      expect(new Set(menu.map((entry) => entry.command)).size).toBe(menu.length);
    }
  });

  it("shows a viewer only the viewer-safe commands and an owner everything", () => {
    const viewer = telegramCommandMenu("viewer").map((entry) => entry.command);
    expect(viewer.toSorted()).toEqual(["help", "projects", "start", "status", "work"]);
    for (const privileged of ["memory", "policy", "debug", "team", "operator", "dashboard"]) {
      expect(viewer).not.toContain(privileged);
    }

    const owner = telegramCommandMenu("owner").map((entry) => entry.command);
    for (const live of [
      "status",
      "projects",
      "work",
      "memory",
      "automation",
      "automations",
      "dashboard",
      "policy",
      "operator",
      "alias",
      "help",
      "start",
      "team",
      "share",
      "debug",
    ]) {
      expect(owner).toContain(live);
    }

    // A member sits between the two: automations yes, policy no.
    const member = telegramCommandMenu("member").map((entry) => entry.command);
    expect(member).toContain("automation");
    expect(member).toContain("share");
    expect(member).not.toContain("policy");
    expect(member).not.toContain("memory");
  });

  it("gates the viewer wall on the same table as the menu", () => {
    for (const safe of ["/status", "/projects 2", "/work", "/help", "/start", "/status@t3captain_bot"]) {
      expect(isViewerSafeMessage(safe)).toBe(true);
    }
    for (const walled of ["/memory", "/policy set x 1", "/debug", "/statis", "/stop", "привет", "/tmp/x.log"]) {
      expect(isViewerSafeMessage(walled)).toBe(false);
    }
    // The wall quotes the table, so its text cannot drift from what it admits.
    const wall = viewerWallText();
    for (const safe of ["/status", "/projects", "/work", "/help"]) expect(wall).toContain(safe);
    expect(wall).not.toContain("/memory");
  });

  it("filters /help by role and tells a viewer what its id is (finding «команды №13»)", () => {
    const viewerHelp = renderHelp("viewer", 4242);
    expect(viewerHelp).toContain("/status");
    expect(viewerHelp).toContain("/projects");
    for (const privileged of ["/memory", "/policy", "/debug", "/team", "/automation"]) {
      expect(viewerHelp).not.toContain(privileged);
    }
    // The footnote about the limit, plus the id the owner needs for /team set.
    expect(viewerHelp).toContain("\\*");
    expect(viewerHelp).toContain("4242");

    const ownerHelp = renderHelp("owner");
    for (const live of ["/status", "/memory", "/automation", "/policy", "/debug", "/share", "/alias"]) {
      expect(ownerHelp).toContain(live);
    }
    for (const dead of RETIRED) expect(ownerHelp).not.toContain(`/${dead}`);
    // /help must not promise a page argument for a list that has none.
    expect(ownerHelp).toContain("/projects [страница]");
  });

  it("reads a command token only where Telegram would", () => {
    expect(commandNameOf("/status")).toBe("status");
    expect(commandNameOf("/Status ARG")).toBe("status");
    expect(commandNameOf("/status@t3captain_bot 2")).toBe("status");
    // Not commands: a path, a bare slash, Cyrillic, a word glued to the slash.
    expect(commandNameOf("/tmp/report.log посмотри")).toBeUndefined();
    expect(commandNameOf("/")).toBeUndefined();
    expect(commandNameOf("/статус")).toBeUndefined();
    expect(commandNameOf("посмотри /status")).toBeUndefined();
  });

  it("leaves the commands package 1.3 retired as ordinary text", () => {
    for (const dead of RETIRED) {
      expect(commandNameOf(`/${dead}`)).toBe(dead);
      // …but they are not dispatchable, so they reach the agent unchanged
      // instead of collecting a «не знаю такую команду» downgrade.
      expect(dispatchableCommandName(`/${dead} что-нибудь`)).toBeUndefined();
    }
    expect(dispatchableCommandName("/statis")).toBe("statis");
    expect(dispatchableCommandName("/status")).toBe("status");
  });

  it("suggests the nearest live command for a typo and never one the role cannot run", () => {
    expect(editDistance("statis", "status")).toBe(1);
    expect(editDistance("projekts", "projects")).toBe(1);
    expect(editDistance("stat", "status")).toBe(2);
    expect(editDistance("", "abc")).toBe(3);
    expect(editDistance("same", "same")).toBe(0);

    expect(suggestCommand("statis", "owner")).toBe("status");
    expect(suggestCommand("projekts", "owner")).toBe("projects");
    expect(suggestCommand("polcy", "owner")).toBe("policy");
    // Distance > 2 is not a typo, it is a different word.
    expect(suggestCommand("развернуть", "owner")).toBeUndefined();
    // A viewer is never pointed at a command the wall would refuse.
    expect(suggestCommand("polcy", "viewer")).toBeUndefined();

    const reply = unknownCommandReply("statis", "owner");
    expect(reply).toContain("Не знаю команду `/statis`");
    expect(reply).toContain("Похоже на `/status`?");
    expect(reply).toContain("`/help`");
    expect(unknownCommandReply("развернуть", "owner")).not.toContain("Похоже на");
  });

  it("pages a list, marks the last page, and refuses one that does not exist", () => {
    const items = Array.from({ length: 47 }, (_, index) => index + 1);

    const first = paginateCommandList(items, 1, "/projects");
    expect(first.items).toHaveLength(COMMAND_PAGE_SIZE);
    expect(first.items[0]).toBe(1);
    expect(first.total).toBe(47);
    expect(first.pageCount).toBe(3);
    expect(first.footer).toBe("Показано 1–20 из 47 — `/projects 2` для следующей страницы.");

    const second = paginateCommandList(items, 2, "/projects");
    expect(second.items[0]).toBe(21);
    expect(second.items.at(-1)).toBe(40);
    expect(second.footer).toContain("Показано 21–40 из 47");
    expect(second.footer).toContain("`/projects 3`");

    const last = paginateCommandList(items, 3, "/projects");
    expect(last.items).toHaveLength(7);
    expect(last.footer).toBe("Показано 41–47 из 47 — это последняя страница.");

    for (const page of [0, 4, -1, 1.5]) {
      const view = paginateCommandList(items, page, "/projects");
      expect(view.items).toHaveLength(0);
      expect(view.outOfRange).toContain("всего 3");
    }

    // One page fits: no footer at all, and page 2 still does not exist.
    const short = paginateCommandList([1, 2, 3], 1, "/work");
    expect(short.footer).toBeUndefined();
    expect(paginateCommandList([1, 2, 3], 2, "/work").outOfRange).toBeDefined();

    // An empty list is one empty page, not a missing one.
    const empty = paginateCommandList([], 1, "/work");
    expect(empty.items).toHaveLength(0);
    expect(empty.outOfRange).toBeUndefined();
  });

  it("reads a page argument, and refuses to guess at one that is not a number", () => {
    expect(parseCommandPage(undefined)).toBe(1);
    expect(parseCommandPage("")).toBe(1);
    expect(parseCommandPage("  ")).toBe(1);
    expect(parseCommandPage("2")).toBe(2);
    expect(parseCommandPage(" 12 ")).toBe(12);
    expect(parseCommandPage("0")).toBe(0);
    for (const nonsense of ["две", "2x", "-1", "1.5"]) {
      expect(parseCommandPage(nonsense)).toBeUndefined();
    }
  });

  it("keeps every catalogue row usable: unique names, a menu line, a role", () => {
    const names = OPERATOR_COMMANDS.flatMap((spec) => [spec.name, ...(spec.aliases ?? [])]);
    expect(new Set(names).size).toBe(names.length);
    for (const spec of OPERATOR_COMMANDS) {
      expect(spec.menu.trim()).not.toBe("");
      expect(["viewer", "member", "admin"]).toContain(spec.minRole);
      // Every паginated command documents its page argument in /help.
      if (spec.paginated && spec.help) expect(spec.help).toContain("[страница]");
    }
  });
});
