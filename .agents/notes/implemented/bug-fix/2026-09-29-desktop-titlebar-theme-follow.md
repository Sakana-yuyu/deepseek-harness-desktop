# Agent Note: Desktop title bar follows the app theme, then the system

Status: implemented

English | [中文](2026-09-29-desktop-titlebar-theme-follow.zh.md)

## Problem

The shell window was created with `.theme(Some(Theme::Dark))` and `shell.html` shipped one dark palette with no detection. With the client switched to light — reported on macOS — the custom title bar stayed black, and nothing reacted to theme changes.

## Decision

- Window creation reads the OS scheme once (`AppsUseLightTheme` on Windows, `defaults read -g AppleInterfaceStyle` on macOS, light when unreadable) to seed `theme()` and `background_color()`; Tauri exposes no app-level theme getter before the first window.
- The authoritative signal after boot is the client's own resolved scheme. The upstream theme presenter keeps `body[data-ds-dark-theme]` current (the Electron preload already mirrors `html[data-ds-theme-source]` from the same presenter), so the content webview gets an initialization script with a `MutationObserver` over that attribute. Every change POSTs the effective mode to the shell notify server's `/theme` route with `mode: 'no-cors'` — a simple request that needs no CORS handshake on the loopback server.
- The shell stores the latest report and mirrors it onto the title bar through the same `__DSH_CHROME_THEME__` hook the system path uses; `WindowEvent::ThemeChanged` applies the OS scheme only while no client report has arrived (splash-to-first-paint window).
- `shell.html` defines the light palette next to the dark one via a `body.light` class; live switches never reload the page. The content webview needs no shell support beyond the report channel: WebView2 and WKWebView resolve `prefers-color-scheme` natively, so the client's own `system` preference keeps working.

## Alternatives considered

- Follow only the system scheme. Rejected: the user's report was the in-app appearance setting; an app set to light on a dark system would still mismatch.
- Tauri IPC from the content webview (`set_shell_theme` command). Rejected: the content webview is outside every capability, and granting one grants the ACL surface that comes with it; the notify server already exists, is loopback-bound, and needs one route.
- Read the Host user-settings document from disk. Rejected: it couples the shell to dsh's on-disk settings format and still misses in-memory switches that are not yet flushed.

## Consequences

- The title bar matches the client palette on first report and on every in-app or OS-driven scheme change, without reloads.
- When the notify server is unavailable the observer never arms and the bar degrades to system following; reports are logged, and unknown modes are ignored.
- The report channel is one-way (content → shell); the shell never injects state into the client page.
