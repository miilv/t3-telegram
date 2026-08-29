#!/usr/bin/env python3
"""PreToolUse gate in front of the paid Higgsfield tools.

The business rule this enforces has one line: the agent does not spend the
owner's money on its own. Everything below is that rule made mechanical.

WHAT THIS IS NOT. It stops an inattentive agent, not a determined one. The bot
runs as root with `OPERATOR_FULL_ACCESS=true`, so the agent can in principle
rewrite this file, the settings file that installs it, or the transcript it
reads — a gate living inside the blast radius cannot bound the blast. The real
spending limit is on the Higgsfield ACCOUNT: the owner is expected to set a
credit/spend cap there, and that is the only boundary that holds against an
agent that means it. `chattr +i` on this file and on claude-settings.json
raises the cost of the trivial rewrite (see RUNBOOK step 13).

Protocol (Claude Code PreToolUse hook): the event arrives as JSON on stdin, the
verdict leaves as JSON on stdout. Exit 0 with no output means "no opinion",
which is how every free tool leaves this script. A refusal prints the deny
payload AND exits 2 with the reason on stderr: measured against CLI 2.1.233,
exit 2 is the only exit code the CLI treats as blocking by itself, so a refusal
that relied on the JSON alone would evaporate on any path where stdout is lost.

Three conditions must ALL hold for a paid call to pass:

1. The tool is not on the FREE list — and everything under `mcp__higgsfield__`
   that is not literally one of those names is paid. Deny by default: a tool
   nobody has ever seen costs money until someone proves otherwise.
2. `mcp__higgsfield__get_cost` was called in THIS turn — after the owner's last
   message, i.e. as part of the work the agent is doing right now. A price from
   the turn before it is a price for something else.
3. The owner's newest message says yes, and does not say no. "Newest message"
   means the newest `<<<inbound:…>>>` fence of the last user entry — the daemon
   builds that entry, and only the text inside an `inbound` fence came from the
   owner's own keyboard. Memory notes, quoted messages, worker output, OCR of
   an attached picture and forwarded material all live in the same entry and
   are all writable, directly or indirectly, by somebody who is not the owner.

Anything unexpected — an unparseable event, a missing transcript, an envelope
without a fence, an exception — blocks. A gate that fails open is not a gate.
"""

from __future__ import annotations

import json
import re
import sys

# The name matched by the settings matcher is the whole `mcp__<server>__<tool>`.
# The server name is fixed by the `mcpServers` key in OPERATOR_EXTRA_MCP_CONFIG:
# rename it there and this prefix, the settings matcher and the gate all miss.
TOOL_PREFIX = "mcp__higgsfield__"

# The ONLY tools that pass ungated, as exact and complete names. Reading the
# catalogue and asking the price cost nothing, and gating the price lookup would
# make the price unquotable and condition 2 unreachable.
#
# Deliberately short: it holds the names that are actually attested on Rick's box
# (`get_cost` and `balance` as the media skill's preflight, `job_status` as the
# poll in the 25.08 incident log). A name that only looks harmless — `list_*`,
# `*_explore`, `preset_recommendation` — is not here, because "looks free" is
# how `preset_recommendation` and `remove_bg` walked through the previous
# version of this gate. Add a name here only after checking the server's own
# price list, one line per name.
FREE_TOOLS = frozenset(
    {
        f"{TOOL_PREFIX}get_cost",
        f"{TOOL_PREFIX}balance",
        f"{TOOL_PREFIX}job_status",
    },
)

COST_TOOL = f"{TOOL_PREFIX}get_cost"

# The daemon's fence (packages/shared/src/fencing.ts): `<<<inbound:nonce>>> …
# <<<end:nonce>>>`, nonce = 8 hex chars, fresh per call. Content inside a fence
# has every marker-shaped sequence defanged before it goes in, so a marker found
# here was written by the daemon and by nobody else. `quote`, `worker` and
# `tool` fences exist too and are exactly what must NOT be searched for consent.
INBOUND_OPEN = re.compile(r"<<<inbound:([0-9a-f]{8})>>>")

# The turn instruction the daemon writes above a message carrying forwarded
# material (apps/daemon/src/operator-daemon.ts). The forwarded text is inside
# the same inbound fence as the owner's own words, so a "да" in this envelope
# cannot be attributed to the owner at all — it blocks.
FORWARDED_MARKER = re.compile(r"contains \d+ forwarded message\(s\)")

# Derived material the ingest pipeline appends INSIDE the inbound fence, after
# the owner's own words and never before them, each block opening on its own
# line with a bracketed daemon label: `[OCR of …]`, `[Voice transcript; …]`,
# `[Video keyframes: …]`, `[daemon: …]`. An OCR'd photograph of the word «да» is
# not the owner saying да.
#
# Everything from the first such line to the end of the fence is dropped, rather
# than that line's paragraph: an OCR excerpt is arbitrary text and can contain
# blank lines of its own, so a paragraph-shaped cut leaves the second half of a
# scanned page looking exactly like the owner's own second sentence. Measured —
# a live run walked through that cut before it became this one.
DERIVED_MARKER = re.compile(r"^\s*\[")

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

# A refusal anywhere in the newest message beats a "да" anywhere in it. «да нет,
# не сейчас» is a refusal that contains the word «да»; a gate that reads the two
# words independently reads that sentence backwards, and the direction of the
# mistake is a charge on the owner's card.
VETO = re.compile(
    r"(?<![\w-])("
    r"стоп|стой|отмен(?:и|а|яю|ить)|отставить|не\s+надо|не\s+нужно|не\s+стоит|"
    r"не\s+сейчас|не\s+делай|не\s+генерируй|не\s+запускай|нет|дорого|передума(?:л|ла)|"
    r"погоди|подожди|отбой|потом|"
    r"stop|cancel|abort|wait|no|don'?t|hold\s+on|never\s*mind"
    r")(?![\w-])",
    re.IGNORECASE | re.UNICODE,
)


def block(reason: str) -> None:
    """Deny the call and hand the agent the sentence it should relay.

    Both channels, on purpose: the JSON verdict is what the CLI reads on a clean
    run, and exit 2 is what it honours when it reads nothing else. The previous
    version exited 0, so every failure mode that lost stdout — and 127, 1 and a
    timeout all do — was a silent pass.
    """
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
    sys.stdout.flush()
    print(reason, file=sys.stderr)
    sys.exit(2)


def allow() -> None:
    sys.exit(0)


def is_paid(tool_name: str) -> bool:
    """Deny by default: under this server, everything not named free is paid."""
    return tool_name.startswith(TOOL_PREFIX) and tool_name not in FREE_TOOLS


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


def newest_inbound_block(envelope: str) -> str | None:
    """The last `<<<inbound:…>>>` block of the envelope, or None if there is none.

    Last, not first: the daemon lays the queue out oldest-first and puts the
    current message under it, so the final block is always the newest thing the
    owner said. That ordering is what makes «[1] да [2] отмени» a refusal —
    consent found in an older block of the same envelope is consent to a
    question that has since been withdrawn.
    """
    blocks: list[str] = []
    for match in INBOUND_OPEN.finditer(envelope):
        terminator = f"<<<end:{match.group(1)}>>>"
        end = envelope.find(terminator, match.end())
        blocks.append(envelope[match.end() : end if end != -1 else len(envelope)])
    return blocks[-1] if blocks else None


def owner_words(block: str) -> str:
    """The owner's typed words: the fence up to the first derived-material line.

    Cutting at the first bracketed line also drops an owner sentence that merely
    happens to start with `[`, which is the direction this gate is allowed to
    err in: the cost of the mistake is one extra question, not one extra charge.
    """
    lines: list[str] = []
    for line in block.splitlines():
        if DERIVED_MARKER.match(line):
            break
        lines.append(line)
    return "\n".join(lines)


def cost_was_checked(entries: list[dict], since: int) -> bool:
    """A call to exactly `mcp__higgsfield__get_cost` after `since`.

    Exactly: `mcp__brain__get_cost_of_nothing` used to satisfy this, because the
    name was matched as a substring against any server's tools.
    """
    for entry in entries[since:]:
        if entry.get("type") != "assistant":
            continue
        content = (entry.get("message") or {}).get("content")
        if not isinstance(content, list):
            continue
        for part in content:
            if not isinstance(part, dict) or part.get("type") != "tool_use":
                continue
            if str(part.get("name", "")) == COST_TOOL:
                return True
    return False


def main() -> None:
    raw = sys.stdin.read()
    if not raw.strip():
        # This hook is wired to `mcp__higgsfield__.*` and to nothing else, so an
        # empty event is not "some other tool" — it is a paid call whose event we
        # failed to receive.
        block("Гейт расходов: событие хука пустое; платный вызов не пропущен.")
        return
    try:
        event = json.loads(raw)
    except ValueError:
        block("Не удалось разобрать событие хука; платный вызов не пропущен.")
        return
    if not isinstance(event, dict) or "hook_event_name" not in event:
        block("Событие хука неожиданной формы; платный вызов не пропущен.")
        return
    if event.get("hook_event_name") != "PreToolUse":
        allow()
        return
    tool_name = str(event.get("tool_name", ""))
    if not is_paid(tool_name):
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

    # This turn only: everything after the owner's last message. «Агент назвал
    # цену» → «владелец согласился» → «агент проверил цену ещё раз и запустил»
    # is one extra call and no ambiguity; a price quoted before the last thing
    # the owner said is a price for whatever was being discussed then.
    if not cost_was_checked(entries, turns[-1]):
        block(
            f"Гейт расходов: нужна стоимость в этом же ходе. Вызови {COST_TOOL}, "
            "назови владельцу цену и дождись явного согласия — потом повтори этот вызов.",
        )
        return

    envelope = text_of((entries[turns[-1]].get("message") or {}).get("content"))
    if FORWARDED_MARKER.search(envelope):
        block(
            "Гейт расходов: в последнем сообщении есть пересланный текст, а согласие в нём "
            "нельзя отличить от чужих слов. Попроси владельца подтвердить отдельным сообщением.",
        )
        return
    block_text = newest_inbound_block(envelope)
    if block_text is None:
        block(
            "Гейт расходов: в последнем сообщении владельца не найдено ограждение <<<inbound:…>>>, "
            "то есть собственных слов владельца в этом ходе нет. Спроси подтверждение и повтори вызов.",
        )
        return
    said = owner_words(block_text)
    if VETO.search(said):
        block(
            "Гейт расходов: в последнем сообщении владельца есть отказ или сомнение "
            "(«стоп», «не надо», «нет», «дорого»). Ничего не запускай, переспроси словами.",
        )
        return
    if not CONFIRMATION.search(said):
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
