# Agent Note: Hosted pwsh terminals drop PSReadLine

Status: implemented

English | [中文](2026-08-30-pwsh-terminal-psreadline-removal.zh.md)

## Problem

Persistent pwsh sessions started failing across hosts once current pwsh releases (7.5/7.6 era) shipped: the model-facing `pwsh` tool timed out on commands whose output had already completed, and the Sandbox CI lane went red on `macos-latest` with scrollback floods that pushed real output out of the bounded buffer, empty UTF-8 pin probes, and readiness settling as `inferred_idle` instead of `stdin_read`.

Raw PTY capture pinned the mechanism. The sessions run the interactive ConsoleHost, so PSReadLine owns every prompt: it re-renders the submitted line in several passes (syntax-color sequences, cursor addressing, continuation prompts) and, on Windows, conpty's re-serialization adds erase sequences and literal space runs on top. The terminal layer keeps an append-only sanitized scrollback, so repaint residue lands next to real command output — the persistent tool's completion status regex (`digits immediately followed by a line break`) stopped matching `__DSH_PERSISTENT_PWSH_END_<uuid>:0` lines and every command polled to its timeout. On the macOS runner the same renderer redrew in a loop that exhausted the scrollback line budget during a single command.

## Decision

The terminal-bash pwsh bootstrap now removes PSReadLine from the hosted session (`Remove-Module PSReadLine -ErrorAction SilentlyContinue;` between the encoding preamble and the prompt-function setup). The session never receives interactive keystrokes — every command is one submitted physical line with newlines escaped as `` `n `` — so the line editor contributed nothing its basic fallback does not: the PTY echoes the line once, the prompt function and OSC `133;D;` marker still fire, and the sanitizer's contract is unchanged.

As defense in depth, both persistent tools (`tool-pwsh-persistent`, `tool-bash-persistent`) now extract the completion status by scanning END-marker occurrences from the last and accepting repaint padding spaces around the digits (`^ *(\d+) *(?=\r?\n)`), so conpty residue can no longer block completion detection even where it survives the sanitizer. The echo still cannot fabricate completion: its END nonce continues with a quote character, not digits.

This note owns the PSReadLine removal and the status-extraction tolerance. The prompt-marker and readiness contract remain owned by the terminal backend's bootstrap.

## Alternatives considered

**Parse conpty repaints properly (full terminal emulation).** Rejected: the sanitizer is deliberately line-oriented, and emulating enough of a screen buffer to reconstruct clean output is a large surface serving no product need.

**Spawn pwsh with `-NonInteractive`.** Rejected: ConsoleHost then never runs the prompt function, which is the readiness and marker contract the whole persistent-shell design hangs on.

**Keep PSReadLine and only widen the status regex.** Rejected: the regex only papers over completion detection; the scrollback still carries recolored echo passes, prompt re-renders, and on macOS outright floods that drop real output, so captured command output stays polluted and bounded buffers stay at risk.

## Consequences

Hosted pwsh sessions lose PSReadLine features agents never use (interactive editing, tab completion, syntax-highlighted echo) and gain deterministic single-pass echo: scrollback holds exactly the echoed line plus real output, command completion no longer depends on repaint timing, and captured output stops carrying renderer residue. Users who attach a real interactive terminal to the same backend should not — the terminal seam is agent-hosted only. If a future pwsh stops honoring `Remove-Module` mid-session, the symptom returns as the pre-fix timeouts, and the widened status regex only delays it; the bootstrap string is the single place to revisit.
