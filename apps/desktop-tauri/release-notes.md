# DeepSeek Harness Desktop 0.2.0-rc.1-0.3

## 中文

- 标题栏改为跟随应用内主题：在「设置 → 外观」切换浅色/深色/跟随系统时，顶部标题栏立即同步；「跟随系统」时由系统配色决定。应用启动前的短暂间隙回退为系统配色。
- 桌面壳其余行为不变：宿主保活看门狗、独立 WebView 认证、托盘、通知与签名更新。

更新前请结束正在运行的任务并备份 Harness 主目录。上游进入 rc 阶段但尚未稳定；会话写入可能生成新的版本文件，旧版本无法读取新版本新增的数据。

包含 Windows x64/x86 NSIS、macOS Intel/Apple Silicon DMG，以及 Linux x64 AppImage/deb。更新产物使用 Tauri 签名，尚无操作系统代码签名或 macOS notarization。

## English

- The title bar now follows the in-app theme: switching Appearance between light, dark, and system applies to the title bar immediately; with "system" the OS color scheme decides. Before the app page first reports, the bar falls back to the system scheme.
- The rest of the desktop shell is unchanged: the host keep-alive watchdog, separate WebView authentication, tray, notifications, and signed updates.

Finish running tasks and back up the Harness home before upgrading. Upstream is in the rc stage but not yet stable. Session writes may create a new format generation; older releases cannot read data introduced by the new version.

Includes Windows x64/x86 NSIS, macOS Intel/Apple Silicon DMG, and Linux x64 AppImage/deb. Update artifacts carry Tauri signatures but lack operating-system code signing and macOS notarization.

# DeepSeek Harness Desktop 0.2.0-rc.1-0.2

## 中文

- 修复最小化或系统休眠后智能体后端离线且一直重连不上的问题：桌面壳新增宿主保活看门狗，周期探测 Web 端口；宿主进程消失（如 WSL 休眠后被回收、Node 崩溃）时自动在同一端口重启，并将界面引导到新的认证地址，页面无需手动刷新即可恢复。
- 修复浅色主题下标题栏仍为黑色的问题：标题栏现在跟随系统颜色配置，启动时读取 Windows「应用模式」/macOS「外观」设置，系统切换深浅色时即时更新，窗口底色同步匹配。
- 桌面壳其余行为不变：独立 WebView 认证、托盘、通知与签名更新。

更新前请结束正在运行的任务并备份 Harness 主目录。上游进入 rc 阶段但尚未稳定；会话写入可能生成新的版本文件，旧版本无法读取新版本新增的数据。

包含 Windows x64/x86 NSIS、macOS Intel/Apple Silicon DMG，以及 Linux x64 AppImage/deb。更新产物使用 Tauri 签名，尚无操作系统代码签名或 macOS notarization。

## English

- Fix the agent backend going offline with endless reconnects after minimizing or system sleep: the desktop shell now runs a host keep-alive watchdog that probes the web port periodically. When the Host process disappears (a WSL VM reclaimed after sleep, a crashed Node process), it respawns on the same port and repoints the interface at the fresh authenticated URL, so the page recovers without a manual refresh.
- Fix the title bar staying black under the light theme: the title bar now follows the system color scheme, reading Windows "app mode" / macOS appearance at startup and updating live when the system switches, with the window background matching.
- The rest of the desktop shell is unchanged: the separate WebView authentication, tray, notifications, and signed updates.

Finish running tasks and back up the Harness home before upgrading. Upstream is in the rc stage but not yet stable. Session writes may create a new format generation; older releases cannot read data introduced by the new version.

Includes Windows x64/x86 NSIS, macOS Intel/Apple Silicon DMG, and Linux x64 AppImage/deb. Update artifacts carry Tauri signatures but lack operating-system code signing and macOS notarization.

# DeepSeek Harness Desktop 0.2.0-rc.1-0.1

## 中文

- 同步上游发行标签 `dsh-v0.2.0-rc.1`：定时任务（Schedule）进入默认 Web 组合并支持整体启停，会话日志上传偏好、按请求凭据区分欠费提示、用户提问支持限时等待与迟到答复、会话列表归档三态筛选、语音输入麦克风引导、模型可用性跟踪与账户设置等上游改进。
- 桌面壳改进随上游同步：关闭窗口默认隐藏到托盘并确认可中断退出；Windows 沙箱 ACL 修复与诊断技能；对话框与浮动面板不再遮挡 Windows 标题栏。
- 桌面壳其余行为不变：独立 WebView 认证、自定义标题栏、托盘、通知与签名更新。

更新前请结束正在运行的任务并备份 Harness 主目录。上游进入 rc 阶段但尚未稳定；会话写入可能生成新的版本文件，旧版本无法读取新版本新增的数据。

包含 Windows x64/x86 NSIS、macOS Intel/Apple Silicon DMG，以及 Linux x64 AppImage/deb。更新产物使用 Tauri 签名，尚无操作系统代码签名或 macOS notarization。

## English

- Sync of upstream release tag `dsh-v0.2.0-rc.1`: the Schedule bundle joins the default Web composition with whole-bundle switching, plus a Session Log upload preference, per-request credential prompts that distinguish out-of-credit errors, timed waits and late replies for user questions, three-state archive filtering in the session list, microphone setup guidance for voice input, and available-model tracking with account settings.
- Desktop shell improvements ride along: closing the window now hides to the tray and confirms interruptible quits; Windows sandbox ACL repair with a diagnosis skill; dialogs and floating panels stay clear of the Windows caption.
- The rest of the desktop shell is unchanged: the separate WebView authentication, window controls, tray, notifications, and signed updates.

Finish running tasks and back up the Harness home before upgrading. Upstream is in the rc stage but not yet stable. Session writes may create a new format generation; older releases cannot read data introduced by the new version.

Includes Windows x64/x86 NSIS, macOS Intel/Apple Silicon DMG, and Linux x64 AppImage/deb. Update artifacts carry Tauri signatures but lack operating-system code signing and macOS notarization.

# DeepSeek Harness Desktop 0.1.7-rc.1-0.2

## 中文

- 修复升级后无法启动的问题：dsh 0.1.7 将登录令牌交换的重定向目标从 `/` 改为相对路径 `./`，桌面壳的就绪探测仍按 `/` 判定，导致启动等待超时。现同时接受两种重定向目标。
- 包含 0.1.7-rc.1-0.1 的全部内容：同步上游发行标签 `dsh-v0.1.7-rc.1`，插件兼容性收紧、会话界面工具三阶段呈现、图片预览、电子表格触控板手势等上游改进。
- 桌面壳其余行为不变：独立 WebView 认证、自定义标题栏、托盘、通知与签名更新。

更新前请结束正在运行的任务并备份 Harness 主目录。上游进入 rc 阶段但尚未稳定；会话写入可能生成新的版本文件，旧版本无法读取新版本新增的数据。

包含 Windows x64/x86 NSIS、macOS Intel/Apple Silicon DMG，以及 Linux x64 AppImage/deb。更新产物使用 Tauri 签名，尚无操作系统代码签名或 macOS notarization。

## English

- Fix the post-upgrade startup failure: dsh 0.1.7 changed the login token-exchange redirect target from `/` to the relative path `./`, while the desktop shell's readiness probe still expected `/`, so startup waited until timeout. Both redirect targets are now accepted.
- Includes everything from 0.1.7-rc.1-0.1: sync of upstream release tag `dsh-v0.1.7-rc.1` with tightened plugin compatibility, three-stage tool presentation in the session UI, image previews, spreadsheet trackpad gestures, and other upstream improvements.
- The rest of the desktop shell is unchanged: the separate WebView authentication, window controls, tray, notifications, and signed updates.

Finish running tasks and back up the Harness home before upgrading. Upstream is in the rc stage but not yet stable. Session writes may create a new format generation; older releases cannot read data introduced by the new version.

Includes Windows x64/x86 NSIS, macOS Intel/Apple Silicon DMG, and Linux x64 AppImage/deb. Update artifacts carry Tauri signatures but lack operating-system code signing and macOS notarization.
