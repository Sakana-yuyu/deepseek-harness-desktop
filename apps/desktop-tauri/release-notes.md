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
