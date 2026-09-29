# Agent Note: Desktop title bar follows the system color scheme

Status: implemented

English | [中文](2026-09-29-desktop-titlebar-follows-system-theme.zh.md)

## Problem

The shell window was created with `.theme(Some(Theme::Dark))` and `shell.html` shipped one dark palette with no detection at all. On a system set to light mode — reported on macOS — the client UI switched, but the custom title bar stayed black, and the shell never reacted to a system theme switch.

## Decision

- The window's initial theme is read from the OS at creation: `HKCU\...\Themes\Personalize\AppsUseLightTheme` on Windows and `defaults read -g AppleInterfaceStyle` on macOS, both defaulting to light when unreadable. Tauri exposes no app-level theme getter before the first window, so the direct OS read is the only way to seed `theme()` and `background_color()` for the builder.
- `WindowEvent::ThemeChanged` forwards the new scheme into the shell webview as `window.__DSH_CHROME_THEME__.apply("light"|"dark")`, which toggles a `body.light` class. `shell.html` defines the light palette next to the dark one; live switches update without a reload.
- The content webview needs no shell support: WebView2 and WKWebView already report the OS scheme through `prefers-color-scheme`, and the client's own theme setting remains the client's business.

## Alternatives considered

- Follow the client's in-app theme setting instead of the system. Rejected: that setting lives in dsh user settings behind the content webview's authenticated origin; the shell cannot read it without inventing a cross-webview protocol, and the reported defect was about the system scheme.
- Use `prefers-color-scheme` media queries in `shell.html` only. Rejected as the sole source: WebView2's reported scheme has historically lagged the OS app mode unless the window theme is pinned, so the shell keeps one authoritative signal (the OS read plus `ThemeChanged`) instead of two diverging ones.
- Keep dark only and document it. Rejected: light-mode systems are a supported surface; the mismatch makes the frame look broken next to a light client.

## Consequences

- The title bar, hover states, and window background match the OS scheme at first paint and on live switches.
- macOS traffic-light dots keep their fixed colors on both schemes, matching native macOS behavior.
- The initial theme read is best-effort: an unreadable registry or `defaults` failure defaults to light, matching both OSes' factory default.
