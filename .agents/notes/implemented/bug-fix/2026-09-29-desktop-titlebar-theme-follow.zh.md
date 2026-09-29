# Agent Note：桌面标题栏跟随应用主题，回退系统

Status: implemented

[English](2026-09-29-desktop-titlebar-theme-follow.md) | 中文

## 问题

壳窗口创建时硬编码 `.theme(Some(Theme::Dark))`，`shell.html` 只带一套暗色调色板，没有任何检测。客户端切到浅色后（macOS 有报告），自绘标题栏仍是黑色，且任何主题变化都没有响应。

## 决策

- 窗口创建时读一次 OS 配色（Windows 读 `AppsUseLightTheme`，macOS 读 `defaults read -g AppleInterfaceStyle`，不可读时默认浅色）为 `theme()` 与 `background_color()` 播种；Tauri 在第一个窗口前没有应用级 theme 读取。
- 启动完成后的权威信号是客户端自己解析出的配色。上游主题 presenter 持续维护 `body[data-ds-dark-theme]`（Electron preload 已经在镜像同一 presenter 的 `html[data-ds-theme-source]`），因此给内容 WebView 注入一段初始化脚本，用 `MutationObserver` 监听该属性；每次变化都以 `mode: 'no-cors'` POST 到壳 notify 服务的 `/theme` 路由——简单请求，回环服务器无需 CORS 握手。
- 壳保存最近一次上报，并经由与系统路径相同的 `__DSH_CHROME_THEME__` 钩子镜像到标题栏；`WindowEvent::ThemeChanged` 只在没有客户端上报（闪屏到首帧之间）时应用 OS 配色。
- `shell.html` 以 `body.light` 类在暗色旁定义浅色调色板；实时切换不刷新页面。除上报通道外内容 WebView 无需壳支持：WebView2 与 WKWebView 原生解析 `prefers-color-scheme`，客户端自身的"跟随系统"偏好照常工作。

## 备选方案

- 只跟随系统配色。否决：用户报告的正是应用内外观设置；深色系统上的浅色应用仍会不匹配。
- 内容 WebView 走 Tauri IPC（`set_shell_theme` 命令）。否决：内容 WebView 不在任何 capability 内，而授予一个就意味着授予随之而来的 ACL 面；notify 服务本就存在、只绑回环，加一条路由即可。
- 壳直接读盘上的 Host 用户设置文档。否决：这把壳耦合到 dsh 的落盘设置格式，而且读不到尚未落盘的内存内切换。

## 后果

- 标题栏在首次上报及每次应用内或 OS 驱动的配色变化时与客户端调色板一致，无需刷新。
- notify 服务不可用时观察者不会装配，标题栏退化为跟随系统；上报会记日志，未知模式被忽略。
- 上报通道是单向的（内容 → 壳）；壳从不向客户端页面注入状态。
