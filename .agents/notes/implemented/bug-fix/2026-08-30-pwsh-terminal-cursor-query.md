# Agent Note: Hosted pwsh terminals answer the cursor-position query

Status: implemented

English | [中文](2026-08-30-pwsh-terminal-cursor-query.zh.md)

## Problem

The `macos-latest` runner image moved to pwsh 7.6.4, and every hosted pwsh session went dead on it: no prompt ever rendered, submitted commands never executed, readiness settled only through the silence bound (`inferred_idle`), and the persistent pwsh tool timed out on every command. A raw-PTY capture pinned the mechanism: pwsh 7.6's line editor emits `ESC[6n` — a cursor-position query — during startup and blocks until something answers. A hosted PTY has no emulator behind it, so the query was never answered and the shell never came up.

The pre-existing Windows-side failure is a different residue problem: conpty re-serializes PSReadLine's multi-pass syntax-highlight rendering as erase sequences and literal space runs, and the append-only sanitized scrollback keeps that residue beside real output, which broke the persistent tools' completion-status extraction (`digits immediately followed by a line break`).

## Decision

The terminal layer now answers cursor-position queries. The sanitizer recognizes `ESC[6n` and `ESC[?6n` (including sequences split across chunks), reports them on the sanitized chunk, and the session writes `ESC[1;1R` — the top-left home position — back into the terminal. Any valid answer unblocks the editor; the line-oriented scrollback does not care about rendering layout. The response goes to the shell's input side and is consumed as the query answer, never as command text.

The pwsh bootstrap-wait had to change with it. Matching the rendered prompt in the scrollback cannot work: POSIX PSReadLine positions the prompt with cursor addressing instead of newlines, so the prompt text never appears at a line start, while the echoed bootstrap carries the same literal mid-line. The session's own tracking — an owned `133;D` marker followed by the controlled prompt text — is the only echo-proof signal, and it is now exposed as the sticky `controlledPromptRendered` flag that the bootstrap wait gates on.

On Windows the pwsh bootstrap also keeps removing PSReadLine (`Remove-Module PSReadLine` between the encoding preamble and the prompt-function setup): conpty's repaint residue is a Windows-protocol artifact, the removal eliminates it at the source, and the Windows console line input works fine without PSReadLine. POSIX keeps PSReadLine — its renderer is single-pass there once the query is answered, and the no-PSReadLine fallback editor turned out to be unusable over a PTY (a session reduced to an echoed bootstrap line and a default prompt that never consumed input).

As defense in depth, both persistent tools (`tool-pwsh-persistent`, `tool-bash-persistent`) extract the completion status by scanning END-marker occurrences from the last and tolerating repaint padding spaces around the digits (`^ *(\d+) *(?=\r?\n)`), so surviving residue cannot block completion detection. The echo still cannot fabricate completion: its END nonce continues with a quote character, not digits.

This note owns the cursor-query response and the Windows-scoped PSReadLine removal. The prompt-marker and readiness contract remain owned by the terminal backend's bootstrap.

## Alternatives considered

**Keep PSReadLine everywhere.** Rejected on Windows: conpty repaint residue survives in the scrollback, polluting captured output regardless of the query answer.

**Remove PSReadLine everywhere.** Rejected on POSIX: measured on the runner, the fallback editor never consumed PTY input at all — sessions degraded to a dead default prompt — while PSReadLine with an answered query is the long-proven configuration.

**Full terminal emulation.** Rejected: the sanitizer is deliberately line-oriented, and emulating enough of a screen buffer to answer queries from real cursor state is a large surface serving no product need beyond this handshake.

**Spawn pwsh with `-NonInteractive`.** Rejected: ConsoleHost then never runs the prompt function, which is the readiness and marker contract the whole persistent-shell design hangs on.

## Consequences

pwsh 7.6+ sessions come up on every host: the editor's startup handshake completes, prompts render once, and commands execute without the renderer retry loops that previously flooded the scrollback. Windows additionally runs PSReadLine-free, so captured output carries no conpty residue. A future shell that issues other terminal queries (device attributes, for example) will hang the same way; the sanitizer's CSI scan is the single place to extend. If a pwsh release changes the query form or stops asking, the failure mode is visible immediately as a dead first prompt, and the diagnostic path — raw node-pty against the runner's pwsh — reproduces it in one CI run.
