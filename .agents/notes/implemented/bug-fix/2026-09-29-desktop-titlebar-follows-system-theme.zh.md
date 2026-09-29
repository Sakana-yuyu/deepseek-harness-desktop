# Agent Note：桌面标题栏跟随系统颜色配置

Status: implemented

[English](2026-09-29-desktop-titlebar-follows-system-theme.md) | 中文

## 问题

壳窗口创建时硬编码 `.theme(Some(Theme::Dark))`，`shell.html` 只带一套暗色调色板，没有任何检测。系统设为浅色的机器上（macOS 有报告），客户端 UI 已切换，但自绘标题栏仍是黑色，壳也不会响应系统深浅色切换。

## 决策

- 窗口初始主题在创建时直接读 OS：Windows 读 `HKCU\...\Themes\Personalize\AppsUseLightTheme`，macOS 读 `defaults read -g AppleInterfaceStyle`，读取失败时默认浅色。Tauri 在第一个窗口创建前没有应用级 theme 读取，所以直接读 OS 是为 builder 播种 `theme()` 与 `background_color()` 的唯一途径。
- `WindowEvent::ThemeChanged` 把新的配色方案以 `window.__DSH_CHROME_THEME__.apply("light"|"dark")` 转发给壳 WebView，切换 `body.light` 类。`shell.html` 在暗色旁定义了浅色调色板；实时切换无需刷新页面。
- 内容 WebView 无需壳支持：WebView2 与 WKWebView 本就通过 `prefers-color-scheme` 上报系统配色，客户端自己的主题设置仍归客户端管。

## 备选方案

- 跟随客户端应用内主题设置而非系统。否决：该设置存放在内容 WebView 认证源背后的 dsh 用户设置里，壳无法在不发明跨 WebView 协议的前提下读取，且用户报告的缺陷针对系统配色。
- 仅在 `shell.html` 用 `prefers-color-scheme` 媒体查询。否决其作为唯一来源：WebView2 上报的配色在窗口主题未钉死时历史上会滞后于系统应用模式，因此壳保持单一权威信号（OS 读取加 `ThemeChanged`），避免两套信号分叉。
- 维持纯暗色并在文档说明。否决：浅色系统是受支持的使用面；配色不匹配会让边框在浅色客户端旁显得破损。

## 后果

- 标题栏、悬停态与窗口底色在首帧即匹配 OS 配色，并在实时切换时保持一致。
- macOS 红绿灯圆点在两种配色下保持固定颜色，与原生 macOS 行为一致。
- 初始主题读取是尽力而为：注册表或 `defaults` 不可读时默认浅色，与两个 OS 的出厂默认一致。
