# Agent Note: Desktop shell keeps the Host alive with a respawn watchdog

Status: implemented

English | [中文](2026-09-29-desktop-host-watchdog.zh.md)

## Problem

The desktop shell spawns `dsh web` once at boot and never checks on it. When the Host process disappears while the shell runs — a WSL VM reclaimed after system sleep, a crashed Node process — the served page keeps retrying against a dead loopback origin forever. Users see the agent "offline" with endless reconnects and must quit and relaunch the whole app.

## Decision

- A watchdog task starts after boot completes. Every 15 seconds it probes the Host's loopback origin with an unauthenticated GET; any response (401 auth wall included) proves a live listener. Three consecutive failures — roughly 45 seconds of silence — declare the Host dead.
- On death the watchdog stops the dead Host handle and respawns through the same launch path recorded at boot (`spawn_web_host` for the Windows Node runtime, `spawn_wsl_web_host` for WSL), preferring the port the page still points at, so the served page's own reconnect loop recovers without navigation whenever the port is free.
- If the respawned Host answers on a different port, the shell navigates the content webview to the fresh authenticated URL (`dsh web`'s one-time token line). The token exchange mints a session cookie, so the page lands back in the app without user action.
- The respawn URL and Host handle replace the managed `DesktopRuntime` fields, so the tray, plugin commands, and shutdown reaping always target the live generation.
- One toast per outage, not per cycle. Probe failures never restart the shell itself.

## Alternatives considered

- Monitor the child process handle instead of HTTP. Rejected: process liveness is not service liveness — a hung Node process would pass, and the WSL path only exposes the `wsl.exe` stub pid; HTTP probing measures the actual contract the page depends on.
- Restart the whole shell on Host death. Rejected: it destroys in-flight agent work and the close-minimize preference users rely on; the page is designed to repull after a connection reset.
- Patch the served client to reload on visibility. Rejected: the served web app is upstream code; a shell-side injected WebSocket wrapper or forced reload would fight the client's own recovery loop and cannot mint a session on a new origin. The Rust layer owns the Host lifecycle.

## Consequences

- Backend outages heal without user action: the UI reconnects against the same port, or lands on a fresh authenticated URL after a navigation.
- A Host that cannot start (broken tree, blocked ports) logs a respawn failure per cycle in boot.log and keeps the shell usable for other work; the watchdog never exits on respawn failure.
- `DesktopRuntime.host` and `web_url` are now behind read locks; the watchdog is the only writer after boot.
