#!/usr/bin/env python3
"""PreToolUse gate in front of the paid Higgsfield generation tools.

The business rule this enforces has one line: the agent does not spend the
owner's money on its own. Everything below is that rule made mechanical.

Protocol (Claude Code PreToolUse hook): the event arrives as JSON on stdin,
the verdict leaves as JSON on stdout. Exit 0 with no output means "no opinion",
which is how every non-paid tool leaves this script. A blocked call exits 0 too
and says so in the payload; the CLI turns that into a tool result the agent
reads and relays to the owner in its own words.

Two conditions must BOTH hold for a paid call to pass:

1. A `get_cost` call happened recently — in this turn or the one before it. A
   price nobody looked up cannot have been quoted to anyone.
2. The owner's latest message confirms it in so many words. The transcript's
   last user-role message is the one composed from what the owner actually
   typed in Telegram; the agent cannot write into it.

Both are needed because either alone is the failure everyone expects: a price
that was quoted last week, or a "yes" to a question that was never about money.

Anything unexpected — an unparseable event, a missing transcript, an exception —
blocks. A gate that fails open is not a gate.
"""

from __future__ import annotations

import json
import re
import sys

# The name matched by the settings matcher is the whole `mcp__<server>__<tool>`.
TOOL_PREFIX = "mcp__higgsfield__"

# Paid: anything that makes a new asset. Written as substrings of the tool name
# so that a renamed or newly added `generate_video_v2` is caught by default.
PAID = (
    "generate",
    "upscale",
    "enhance",
    "animate",
    "video",
    "image",
    "render",
    "inpaint",
    "outpaint",
    "edit",
    "motion",
    "speak",
    "voice",
    "restyle",
)

# Free: reading the catalogue and, above all, asking the price. Checked first,
# so `get_cost_of_generation` is a lookup and not a generation.
FREE = ("get_cost", "cost", "list", "status", "info", "describe", "search", "get_job", "poll")

COST_TOOL = "get_cost"

# Deliberately short and deliberately explicit. "хорошо", "понял", "ага" are
# acknowledgements of a sentence, not authorisations of a charge.
CONFIRMATION = re.compile(
    r"(?<![\w-])("
    r"да|дa|подтвержда[юе]|подтверждаю|подтверждено|согласен|согласна|"
    r"генерир(?:уй|уем)|делай|поехали|запускай|разрешаю|"
    r"yes|confirm(?:ed)?|approve[d]?|go\s+ahead|do\s+it"
    r")(?![\w-])",
    re.IGNORECASE | re.UNICODE,
)


def block(reason: str) -> None:
    """Deny the call and hand the agent the sentence it should relay."""
    print(
        json.dumps(
            {
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "deny",
                    "permissionDecisionReason": reason,
                },
            },
        ),
    )
    sys.exit(0)


def allow() -> None:
    sys.exit(0)


def is_paid(tool_name: str) -> bool:
    short = tool_name[len(TOOL_PREFIX):] if tool_name.startswith(TOOL_PREFIX) else tool_name
    short = short.lower()
    if any(marker in short for marker in FREE):
        return False
    return any(marker in short for marker in PAID)


def text_of(content: object) -> str:
    """The human-readable text of a transcript message, whatever its shape."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(
            part.get("text", "")
            for part in content
            if isinstance(part, dict) and part.get("type") == "text"
        )
    return ""


def is_tool_result(content: object) -> bool:
    return isinstance(content, list) and any(
        isinstance(part, dict) and part.get("type") == "tool_result" for part in content
    )


def read_transcript(path: str) -> list[dict]:
    entries: list[dict] = []
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
            except ValueError:
                # One truncated line at the tail is normal while the CLI writes;
                # it is not a reason to refuse a call the owner already approved.
                continue
            if isinstance(entry, dict):
                entries.append(entry)
    return entries


def owner_messages(entries: list[dict]) -> list[int]:
    """Indices of the real owner turns — tool results are user-role too."""
    indices = []
    for index, entry in enumerate(entries):
        if entry.get("type") != "user" or entry.get("isMeta"):
            continue
        content = (entry.get("message") or {}).get("content")
        if is_tool_result(content):
            continue
        indices.append(index)
    return indices


def cost_was_checked(entries: list[dict], since: int) -> bool:
    for entry in entries[since:]:
        if entry.get("type") != "assistant":
            continue
        content = (entry.get("message") or {}).get("content")
        if not isinstance(content, list):
            continue
        for part in content:
            if not isinstance(part, dict) or part.get("type") != "tool_use":
                continue
            if COST_TOOL in str(part.get("name", "")).lower():
                return True
    return False


def main() -> None:
    try:
        event = json.loads(sys.stdin.read() or "{}")
    except ValueError:
        block("Не удалось разобрать событие хука; платный вызов не пропущен.")
        return
    if not isinstance(event, dict) or event.get("hook_event_name") != "PreToolUse":
        allow()
        return
    tool_name = str(event.get("tool_name", ""))
    if not tool_name.startswith(TOOL_PREFIX) or not is_paid(tool_name):
        allow()
        return

    transcript_path = event.get("transcript_path")
    if not isinstance(transcript_path, str) or not transcript_path:
        block(
            "Гейт расходов: нет расшифровки хода, подтвердить стоимость невозможно. "
            "Спроси у владельца цену и явное согласие, потом повтори вызов.",
        )
        return
    try:
        entries = read_transcript(transcript_path)
    except OSError:
        block(
            "Гейт расходов: расшифровка хода недоступна, подтвердить стоимость невозможно. "
            "Спроси у владельца цену и явное согласие, потом повтори вызов.",
        )
        return

    turns = owner_messages(entries)
    if not turns:
        block(
            "Гейт расходов: в этом ходе нет сообщения владельца, значит согласия тоже нет. "
            "Спроси цену и явное согласие, потом повтори вызов.",
        )
        return

    # This turn and the one before it: the natural shape of the exchange is
    # «агент назвал цену» → «владелец согласился», and those are two turns.
    since = turns[-2] if len(turns) >= 2 else turns[-1]
    if not cost_was_checked(entries, since):
        block(
            f"Гейт расходов: нужна стоимость до генерации. Вызови {TOOL_PREFIX}{COST_TOOL}, "
            "назови владельцу цену и дождись явного согласия — потом повтори этот вызов.",
        )
        return

    latest = text_of((entries[turns[-1]].get("message") or {}).get("content"))
    if not CONFIRMATION.search(latest):
        block(
            "Гейт расходов: цена известна, но явного согласия владельца в последнем "
            "сообщении нет. Назови стоимость и спроси подтверждение, потом повтори вызов.",
        )
        return
    allow()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # noqa: BLE001 — a gate that fails open is not a gate.
        block(f"Гейт расходов: внутренняя ошибка ({error.__class__.__name__}); вызов не пропущен.")
