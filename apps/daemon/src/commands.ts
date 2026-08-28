import type { TeamRole } from "../../../packages/shared/src/index.js";

/**
 * Package 4.3: the one place that knows which slash commands exist.
 *
 * Before this module the command surface lived in three places that drifted
 * apart: the `handleCommand` branch chain, the hand-written `/help` text, and
 * the `isViewerSafeMessage` regex — and nowhere at all in Telegram itself, so
 * the client showed neither autocomplete nor a «Меню» button (finding
 * «команды №1»). Everything user-visible about a command is now derived from
 * this table: the Telegram menu, `/help` per role, the viewer wall, and the
 * did-you-mean suggestion for an unknown command.
 *
 * Adding a command means adding a row here AND a branch in `handleCommand`;
 * `tests/daemon.integration.test.ts` asserts the two stay in step.
 */

/** The lowest team role that may use a command. `admin` implies `owner` too. */
export type CommandMinRole = "viewer" | "member" | "admin";

export interface OperatorCommandSpec {
  /** Canonical spelling without the leading slash. */
  readonly name: string;
  /** Extra spellings dispatching to the same handler (`/automations`). */
  readonly aliases?: readonly string[];
  /** One line for Telegram's command menu: plain text, ≤256 chars, no markup. */
  readonly menu: string;
  /** One line for `/help`; may use markdown. Omitted commands are dispatchable but unlisted. */
  readonly help?: string;
  readonly minRole: CommandMinRole;
  /** Lists whose length is user data and therefore paginated (`/projects 2`). */
  readonly paginated?: boolean;
}

export const OPERATOR_COMMANDS: readonly OperatorCommandSpec[] = [
  {
    name: "status",
    menu: "Активная и недавняя работа",
    help: "- `/status` — активная и недавняя работа",
    minRole: "viewer",
  },
  {
    name: "projects",
    menu: "Проекты",
    help: "- `/projects [страница]` — проекты",
    minRole: "viewer",
    paginated: true,
  },
  {
    name: "work",
    menu: "Рабочие треды",
    help: "- `/work [страница]` — рабочие треды",
    minRole: "viewer",
    paginated: true,
  },
  {
    name: "help",
    menu: "Список команд",
    help: "- `/help` — этот список",
    minRole: "viewer",
  },
  {
    // Telegram sends /start on the first open of the chat, so it stays in the
    // menu even though its answer is the same справка as /help.
    name: "start",
    menu: "Начало работы и список команд",
    minRole: "viewer",
  },
  {
    name: "automation",
    aliases: ["automations"],
    menu: "Регулярные задачи по расписанию",
    help: "- `/automation [страница]` — регулярные задачи; `add`, `pause <id>`, `resume <id>`, `delete <id>`",
    minRole: "member",
    paginated: true,
  },
  {
    name: "alias",
    menu: "Постоянный алиас проекта",
    help: "- `/alias <проект> | <алиас>` — постоянный алиас проекта",
    minRole: "member",
  },
  {
    name: "share",
    menu: "Доступ к проекту",
    help: "- `/share <проект> <id-пользователя> <owner|editor|viewer>` — доступ к проекту; имя проекта можно писать с пробелами или алиасом",
    minRole: "member",
  },
  {
    name: "memory",
    menu: "Долговременные заметки",
    help: "- `/memory [страница]` — долговременные заметки; `remember`, `search`, `forget <id>`, `restore <id>`, `compact`",
    minRole: "admin",
    paginated: true,
  },
  {
    name: "team",
    menu: "Роли команды",
    help: "- `/team` — роли команды",
    minRole: "admin",
  },
  {
    name: "dashboard",
    menu: "Ссылка на локальную панель",
    help: "- `/dashboard` — ссылка на локальную панель",
    minRole: "admin",
  },
  {
    name: "policy",
    menu: "Локальные настройки",
    help: "- `/policy` — локальные настройки; `set <ключ> <значение>`",
    minRole: "admin",
  },
  {
    name: "operator",
    menu: "Движок Operator и переключение",
    help: "- `/operator` — какой движок сейчас работает и переключение",
    minRole: "admin",
  },
  {
    name: "debug",
    menu: "Диагностика демона",
    help: "- `/debug` — диагностика",
    minRole: "admin",
  },
];

const ROLE_RANK: Record<TeamRole, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };
const MIN_ROLE_RANK: Record<CommandMinRole, number> = { viewer: 0, member: 1, admin: 2 };

const SPEC_BY_NAME = new Map<string, OperatorCommandSpec>(
  OPERATOR_COMMANDS.flatMap((spec) => [spec.name, ...(spec.aliases ?? [])].map((name) => [name, spec] as const)),
);

/**
 * A command-shaped opening token: `/name`, optionally `@botname`, ending at a
 * space or the end of the message. Telegram command names are ASCII only, so a
 * path (`/tmp/x.log`) or a Cyrillic «/статус» is deliberately not a command and
 * still reaches the agent as ordinary text.
 */
const COMMAND_TOKEN = /^\/([a-z0-9_]{1,32})(?:@[a-zA-Z0-9_]{1,32})?(?=\s|$)/iu;

/**
 * Package 1.3 retired these, and it retired them into ordinary text on
 * purpose: «/stop» is muscle memory for a semantic stop that the Operator can
 * actually perform via `t3.interrupt_thread`, and «/focus …» is a sentence
 * about context the agent can act on. Answering them with «не знаю такой
 * команды» would be a downgrade dressed as a fix, so package 4.3's unknown-
 * command shortcut deliberately does not claim them: they are not unknown
 * commands, they are not commands at all.
 */
const RETIRED_COMMANDS: ReadonlySet<string> = new Set(["stop", "cancel", "focus"]);

/** The bare command name (no slash, no `@bot`) opening this text, if any. */
export function commandNameOf(text: string): string | undefined {
  return COMMAND_TOKEN.exec(text.trim())?.[1]?.toLocaleLowerCase();
}

/**
 * Everything after the leading `/command` (or `/command@bot`) token — the other
 * half of reading a command, kept beside the token regex so the two can never
 * disagree about where the name ends. Package 4.3 review: there were four
 * hand-rolled parsers of this shape; this is the only one now.
 */
export function commandArguments(text: string): string {
  return text.trim().replace(COMMAND_TOKEN, "").trim();
}

/**
 * The command name this text should be dispatched on — live or merely
 * misspelled. `undefined` for a retired command, which travels to the agent as
 * the ordinary text package 1.3 made it.
 */
export function dispatchableCommandName(text: string): string | undefined {
  const name = commandNameOf(text);
  return name !== undefined && !RETIRED_COMMANDS.has(name) ? name : undefined;
}

function commandSpecFor(text: string): OperatorCommandSpec | undefined {
  const name = commandNameOf(text);
  return name ? SPEC_BY_NAME.get(name) : undefined;
}

function roleAllowsCommand(role: TeamRole, spec: OperatorCommandSpec): boolean {
  return ROLE_RANK[role] >= MIN_ROLE_RANK[spec.minRole];
}

export function commandsForRole(role: TeamRole): OperatorCommandSpec[] {
  return OPERATOR_COMMANDS.filter((spec) => roleAllowsCommand(role, spec));
}

/**
 * `OPERATOR_MENU`: how much of the table Telegram is told about. This is a
 * publication filter only — `handleCommand` keeps dispatching every command
 * typed by hand in all three modes, and `/help` keeps listing them.
 */
export type OperatorMenuMode = "full" | "minimal" | "hidden";

/**
 * The commands `minimal` publishes. `/start` is deliberately absent: Telegram
 * sends it on the first open of a chat whether or not it is in the menu, so it
 * stays dispatchable while taking no room in a menu whose whole point is to be
 * two lines long.
 */
const MINIMAL_MENU_COMMANDS: ReadonlySet<string> = new Set(["help", "status"]);

/**
 * The `setMyCommands` payload for a role: canonical order, plain descriptions.
 * Aliases get their own row — Telegram autocompletes only what it was told
 * about, and `/automations` is a spelling the daemon really does answer — with
 * the relationship spelled out so the menu does not look like two commands.
 *
 * `mode` narrows the result further (`OPERATOR_MENU`); `hidden` returns an
 * empty payload, which is how Telegram is told to drop the «Меню» button for
 * that scope.
 */
export function telegramCommandMenu(
  role: TeamRole,
  mode: OperatorMenuMode = "full",
): Array<{ command: string; description: string }> {
  if (mode === "hidden") return [];
  const commands = mode === "minimal"
    ? commandsForRole(role).filter((spec) => MINIMAL_MENU_COMMANDS.has(spec.name))
    : commandsForRole(role);
  return commands.flatMap((spec) => [
    { command: spec.name, description: spec.menu },
    ...(spec.aliases ?? []).map((alias) => ({
      command: alias,
      description: `${spec.menu} (то же, что /${spec.name})`,
    })),
  ]);
}

/**
 * The viewer wall (dialogue-flow §1) reads the same table: a viewer may send
 * exactly the commands whose `minRole` is `viewer`, and nothing else.
 */
export function isViewerSafeMessage(text: string): boolean {
  const spec = commandSpecFor(text);
  return Boolean(spec && spec.minRole === "viewer");
}

/**
 * The wall's own text, so the list it quotes can never drift from the table.
 *
 * Filtered on `help`, which deliberately drops `/start`: the wall ADMITS it
 * (Telegram sends it on the first open of a chat), but naming it in a sentence
 * about what a person may type would be noise rather than information.
 */
export function viewerWallText(): string {
  const allowed = OPERATOR_COMMANDS.filter((spec) => spec.minRole === "viewer" && spec.help)
    .map((spec) => `\`/${spec.name}\``);
  return `Ваша роль \`viewer\` разрешает только ${listRu(allowed)}.`;
}

function listRu(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} и ${items.at(-1)!}`;
}

/**
 * `/help`, filtered by role (finding «команды №13»). A viewer used to read the
 * full 13-line list and then bounce off the wall on most of it; now they see
 * their own commands plus a footnote naming the limit and their user id, which
 * is what the owner needs for `/team set`.
 */
export function renderHelp(role: TeamRole, userId?: number): string {
  const lines = ["## Operator", ""];
  lines.push(
    role === "viewer"
      ? "Роль `viewer` — только чтение: доступны команды ниже. Обычные сообщения я не обрабатываю."
      : "Пишите обычным языком: короткие вопросы я отвечу сам, существенную работу возьму в долгую фоновую работу.",
  );
  lines.push("");
  for (const spec of commandsForRole(role)) {
    if (spec.help) lines.push(spec.help);
  }
  if (role === "viewer") {
    lines.push(
      "",
      // The footnote names no command a viewer cannot run — including the one
      // the owner would use to promote them.
      `\\* Остальные команды и свободный диалог доступны ролям \`member\`, \`admin\` и \`owner\`.${
        userId === undefined ? "" : ` Ваш id: \`${userId}\` — назовите его владельцу, чтобы получить доступ.`
      }`,
    );
  }
  return lines.join("\n");
}

/** Levenshtein distance, capped implicitly by the short strings involved. */
export function editDistance(left: string, right: string): number {
  if (left === right) return 0;
  if (!left.length) return right.length;
  if (!right.length) return left.length;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i, ...new Array<number>(right.length).fill(0)];
    for (let j = 1; j <= right.length; j += 1) {
      const substitution = previous[j - 1]! + (left[i - 1] === right[j - 1] ? 0 : 1);
      current[j] = Math.min(current[j - 1]! + 1, previous[j]! + 1, substitution);
    }
    previous = current;
  }
  return previous[right.length]!;
}

export const COMMAND_SUGGESTION_MAX_DISTANCE = 2;

/**
 * The closest live command to a typo, within distance 2 and visible to this
 * role — so a suggestion never advertises a command the sender may not run.
 */
export function suggestCommand(name: string, role: TeamRole): string | undefined {
  const candidates = commandsForRole(role).flatMap((spec) => [spec.name, ...(spec.aliases ?? [])]);
  let best: { name: string; distance: number } | undefined;
  for (const candidate of new Set(candidates)) {
    const distance = editDistance(name, candidate);
    // Distance 0 is the name itself: «/status? похоже на /status?» is nonsense,
    // and the caller already knows this name did not dispatch.
    if (distance === 0 || distance > COMMAND_SUGGESTION_MAX_DISTANCE) continue;
    if (!best || distance < best.distance) best = { name: candidate, distance };
  }
  return best?.name;
}

/**
 * Finding «команды №3»: an unknown command used to buy a full LLM turn and get
 * an improvisation from an agent that does not know the command list. This
 * answer costs nothing and is always right.
 */
export function unknownCommandReply(name: string, role: TeamRole): string {
  const suggestion = suggestCommand(name, role);
  return [
    `Не знаю команду \`/${name}\`.${suggestion ? ` Похоже на \`/${suggestion}\`?` : ""}`,
    "",
    "Список команд: `/help`.",
  ].join("\n");
}

export const COMMAND_PAGE_SIZE = 20;

export interface CommandPage<T> {
  items: T[];
  page: number;
  pageCount: number;
  total: number;
  /** Trailing «Показано 1–20 из 47 — /projects 2 …» line; absent on a single page. */
  footer?: string;
  /** Set instead of `items` when the requested page does not exist. */
  outOfRange?: string;
}

/**
 * Finding «команды №6»: `/projects` had no limit at all (200 projects became a
 * wall of split messages), `/work` silently cut at 20 and `/memory` at 12.
 *
 * One pattern for all of them: a page argument, not inline buttons. A command
 * reply rides the durable outbox and carries no callback state, so buttons
 * would need a token registry and a durable binding to survive a restart,
 * while `/projects 2` is just another command — it costs nothing, it composes
 * with the batch-remainder path, and the footer that documents it is itself
 * the affordance.
 */
export function paginateCommandList<T>(
  items: readonly T[],
  page: number,
  command: string,
  pageSize = COMMAND_PAGE_SIZE,
): CommandPage<T> {
  const total = items.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  if (!Number.isInteger(page) || page < 1 || page > pageCount) {
    return {
      items: [],
      page,
      pageCount,
      total,
      outOfRange: `Страницы ${page} нет — всего ${pageCount}. Показать первую: \`${command}\`.`,
    };
  }
  const from = (page - 1) * pageSize;
  const slice = items.slice(from, from + pageSize);
  if (pageCount === 1) return { items: slice, page, pageCount, total };
  const shown = `Показано ${from + 1}–${from + slice.length} из ${total}`;
  return {
    items: slice,
    page,
    pageCount,
    total,
    footer:
      page < pageCount
        ? `${shown} — \`${command} ${page + 1}\` для следующей страницы.`
        : `${shown} — это последняя страница.`,
  };
}

/**
 * A page argument: absent means page 1. `undefined` means the argument was
 * present but is not a page number, and the caller should answer with usage
 * instead of guessing.
 */
export function parseCommandPage(raw?: string): number | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return 1;
  return /^\d+$/.test(trimmed) ? Number(trimmed) : undefined;
}
