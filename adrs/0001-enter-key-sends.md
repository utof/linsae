# ADR 0001 — Enter sends, Shift+Enter newlines

**Date:** 2026-05-26.
**Status:** accepted (v0.1).
**Reassessment gate:** at the 7-day success-criterion check in `memory/v0.1-usage.md`.

## Context

The v0.1 composer needs a binding for the `Enter` key. Two conventions exist in the wild:

- **Chat-style:** `Enter` sends, `Shift+Enter` newlines (Telegram, iMessage on macOS, Slack-default, Discord, WhatsApp Web).
- **Editor-style:** `Enter` newlines, `Cmd/Ctrl+Enter` sends (most markdown editors, Slack-with-setting-flipped, Notion's slash-block model, traditional email clients).

The Opus spec review (2026-05-26) flagged this as a long-term commitment worth deciding explicitly rather than defaulting silently. Chat apps successfully train users on `Enter`-to-send for short messages, but markdown-with-math content is longer-form and the muscle memory from text editors is strong. Slack famously added the editor-style binding as a setting after years of user complaints.

## Decision

**v0.1 binds `Enter` to send and `Shift+Enter` to insert a newline.** This matches the Telegram model the user explicitly asked for (multiple references in the brainstorm conversation; the user uses Telegram daily as their current note system), and matches the v21 prototype composer (`v21-design-system/project/ui_kits/v21-app/composer.jsx:46-53`).

No settings UI at v0.1 ships an alternative binding (settings are deferred per `docs/specs/v0.1-rolling-feed-and-search.md` §Non-goals).

## Alternatives

- **Editor-style (`Cmd+Enter` sends, `Enter` newlines).** Rejected at v0.1 because it contradicts the user's stated mental model and the Telegram-style feed framing. Revisit if the 7-day reassessment surfaces friction.
- **Configurable (chat-style default, settings toggle to editor-style).** Rejected at v0.1 because v0.1 ships no settings UI. Defer to v0.2.
- **Mode-sensitive (`Enter` newlines only when composer contains `\n` already; otherwise sends).** Rejected as too clever; a binding that depends on past keystrokes is hard to learn and harder to teach.

## Consequences

**Positive:**
- Matches user's daily mental model from Telegram, lowering the activation cost of switching to linsae.
- Matches the v21 prototype, so the design system's hint copy (`↵ send · ⇧↵ newline`) flows through unchanged.
- One unambiguous binding; nothing for the user to configure or remember-as-different.

**Negative / risks:**
- Users coming from markdown editors will accidentally send half-written multi-paragraph notes by reflex.
- Long-form math note composition is more painful — every paragraph break requires `Shift+Enter`.
- Reversing this decision later (after the user has 200+ notes) is muscle-memory-painful; the reassessment gate exists specifically because of this.

## Reassessment gate

At the 7-day success-criterion check (per `docs/specs/v0.1-rolling-feed-and-search.md` §Goal), the user reviews `memory/v0.1-usage.md` and any explicit "binding feels wrong" entries. If wrong:

1. Switch to editor-style (`Cmd/Ctrl+Enter` sends, `Enter` newlines) in v0.1.x patch.
2. Update this ADR with `**Status:** superseded by ADR 000X` and add a `**Lessons learned:**` section.
3. Add a settings toggle in v0.2 so the next user can pick.

If no friction by day 7, mark this ADR `**Status:** accepted` and proceed.

## Sources

- v21 composer prototype: `v21-design-system/project/ui_kits/v21-app/composer.jsx:46-53` (Enter sends, Shift+Enter newlines).
- Slack history: years of user complaints leading to the editor-style binding setting (industry blog coverage, ~2016 onward).
- Telegram, iMessage, Discord, WhatsApp Web: chat-style binding as default with no settings alternative.
- Opus spec review 2026-05-26 §E3.
