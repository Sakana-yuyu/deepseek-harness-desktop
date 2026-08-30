# Agent Note: 宿主 pwsh 终端卸载 PSReadLine

Status: implemented

[English](2026-08-30-pwsh-terminal-psreadline-removal.md) | 中文

## Problem

当前的 pwsh 版本（7.5/7.6 一代）发布后，持久 pwsh 会话在各类主机上开始失败：模型侧的 `pwsh` 工具对早已执行完成的命令轮询到超时，Sandbox CI 通道在 `macos-latest` 上变红——scrollback 被刷爆、真实输出被挤出有界缓冲、UTF-8 编码 pin 探测返回空、就绪状态从 `stdin_read` 退化成 `inferred_idle`。

对原始 PTY 字节的采集钉死了机制。会话运行的是交互式 ConsoleHost，每个提示符都由 PSReadLine 渲染：它把提交的行重绘多遍（语法着色序列、光标寻址、续行提示符），在 Windows 上 conpty 的再序列化还会叠加擦除序列和字面空格填充。终端层保留的是只追加的净化 scrollback，于是重绘残渣落在真实命令输出旁边——持久工具的完成状态正则（数字后必须紧跟换行）再也匹配不上 `__DSH_PERSISTENT_PWSH_END_<uuid>:0` 行，每条命令都轮询到超时。在 macOS runner 上，同一个渲染器还会陷入重绘循环，单条命令就把 scrollback 的行数预算耗尽。

## Decision

terminal-bash 的 pwsh 启动引导现在把 PSReadLine 从托管会话中移除（`Remove-Module PSReadLine -ErrorAction SilentlyContinue;`，插在编码前导与 prompt 函数安装之间）。会话从不接收交互式按键——每条命令都是一行提交的物理行、换行转义为 `` `n ``——所以行编辑器没有任何基础回退所不具备的价值：PTY 把这行回显一遍，prompt 函数和 OSC `133;D;` 标记照常触发，sanitizer 的约定不变。

作为纵深防御，两个持久工具（`tool-pwsh-persistent`、`tool-bash-persistent`）现在从最后一个 END 标记出现位置向前扫描完成状态，并接受数字两侧的重绘填充空格（`^ *(\d+) *(?=\r?\n)`），即便重绘残渣穿过 sanitizer 也无法再阻断完成检测。回显仍然无法伪造完成：回显中 END 随机数后面跟的是引号字符而不是数字。

本记录拥有 PSReadLine 移除与状态提取容错。提示符标记与就绪约定仍由终端后端的启动引导拥有。

## Alternatives considered

**正确解析 conpty 重绘（完整终端仿真）。** 否决：sanitizer 刻意保持面向行，为重建干净输出而仿真大半屏幕缓冲是一个巨大面，没有产品需求支撑。

**用 `-NonInteractive` 启动 pwsh。** 否决：ConsoleHost 随后不再运行 prompt 函数，而它是整个持久 shell 设计依赖的就绪与标记约定。

**保留 PSReadLine、只放宽状态正则。** 否决：正则只能遮住完成检测这一处；scrollback 里依旧留着重新着色的多遍回显、提示符重绘，macOS 上更有直接挤出真实输出的洪泛，捕获的命令输出照样被污染，有界缓冲照样暴露在风险中。

## Consequences

托管 pwsh 会话失去了 agent 从不使用的 PSReadLine 能力（交互编辑、Tab 补全、着色回显），换来确定性的单遍回显：scrollback 里只有回显行加真实输出，命令完成不再依赖重绘时序，捕获的输出不再携带渲染器残渣。真实交互终端不应也不会接到同一后端——terminal 接口只面向 agent 托管。若未来 pwsh 不再让 `Remove-Module` 在会话中途生效，症状会以修复前的超时形态回归，放宽的状态正则只能拖延；启动引导串是唯一需要重新审视的地方。
