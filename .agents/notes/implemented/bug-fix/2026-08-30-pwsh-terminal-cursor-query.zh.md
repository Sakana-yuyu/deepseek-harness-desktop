# Agent Note: 宿主 pwsh 终端应答光标位置查询

Status: implemented

[English](2026-08-30-pwsh-terminal-cursor-query.md) | 中文

## Problem

`macos-latest` runner 镜像升到 pwsh 7.6.4 之后，所有托管 pwsh 会话在上面全部失效：提示符从不渲染、提交的命令从不执行、就绪只能靠静默兜底（`inferred_idle`）、持久 pwsh 工具对每条命令都轮询到超时。原始 PTY 字节采集钉死了机制：pwsh 7.6 的行编辑器在启动阶段发出 `ESC[6n`——光标位置查询——并阻塞等待应答。托管 PTY 背后没有终端模拟器，查询永远无人应答，shell 永远起不来。

Windows 侧原有的失败是另一类残渣问题：conpty 把 PSReadLine 的多遍语法着色重绘再序列化成擦除序列和字面空格填充，只追加的净化 scrollback 把这些残渣留在真实输出旁边，破坏了持久工具的完成状态提取（「数字后必须紧跟换行」）。

## Decision

终端层现在应答光标位置查询。sanitizer 识别 `ESC[6n` 与 `ESC[?6n`（包括跨 chunk 拆开的序列），在净化结果上打标记，session 向终端写回 `ESC[1;1R`——左上角原点位置。任何合法应答都能解除编辑器的阻塞；面向行的 scrollback 不关心渲染布局。应答写入 shell 的输入侧，被当作查询答案消费，绝不会变成命令文本。

pwsh 启动等待也必须随之修改。在 scrollback 文本里匹配渲染后的提示符是行不通的：POSIX PSReadLine 用光标寻位而不是换行来摆放提示符，提示符文本永远不会出现在行首，而被回显的引导命令却在行中携带同样的字面量。session 自己的追踪——自有 `133;D` 标记后跟受控提示符文本——是唯一不受回显干扰的信号，现在以粘性的 `controlledPromptRendered` 标志暴露，启动等待以它为准。

Windows 上 pwsh 启动引导保留对 PSReadLine 的移除（`Remove-Module PSReadLine`，插在编码前导与 prompt 函数安装之间）：conpty 重绘残渣是 Windows 协议层的产物，移除从源头消灭它，且 Windows 控制台行输入在没有 PSReadLine 时工作正常。POSIX 保留 PSReadLine——查询得到应答后它的渲染在 POSIX 上是单遍的，而无 PSReadLine 的回退编辑器被证实无法在 PTY 上使用（会话退化为一条回显的引导行加一个从不消费输入的默认提示符）。

作为纵深防御，两个持久工具（`tool-pwsh-persistent`、`tool-bash-persistent`）从最后一个 END 标记出现位置向前扫描完成状态，并接受数字两侧的重绘填充空格（`^ *(\d+) *(?=\r?\n)`），即便残渣穿过净化层也无法阻断完成检测。回显仍然无法伪造完成：回显中 END 随机数后面跟的是引号字符而不是数字。

本记录拥有光标查询应答与 Windows 范围的 PSReadLine 移除。提示符标记与就绪约定仍由终端后端的启动引导拥有。

## Alternatives considered

**所有平台都保留 PSReadLine。** Windows 上否决：conpty 重绘残渣留在 scrollback 里，无论查询是否应答，捕获的输出都被污染。

**所有平台都移除 PSReadLine。** POSIX 上否决：在 runner 上实测，回退编辑器完全不消费 PTY 输入——会话退化成一个死掉的默认提示符——而「PSReadLine + 查询应答」是久经验证的配置。

**完整终端仿真。** 否决：sanitizer 刻意保持面向行，为从真实光标状态应答查询而仿真大半屏幕缓冲，是一个远超本次握手需求的巨大面。

**用 `-NonInteractive` 启动 pwsh。** 否决：ConsoleHost 随后不再运行 prompt 函数，而它是整个持久 shell 设计依赖的就绪与标记约定。

## Consequences

pwsh 7.6+ 会话在所有主机上都能正常启动：编辑器的启动握手完成，提示符只渲染一遍，命令执行不再伴随此前刷爆 scrollback 的渲染器重试循环。Windows 额外运行在无 PSReadLine 状态，捕获的输出不再携带 conpty 残渣。未来的 shell 若发出其他终端查询（比如设备属性）会以同样方式挂起；sanitizer 的 CSI 扫描是唯一需要扩展的地方。若某个 pwsh 版本更改查询形式或不再询问，失败模式会立即表现为第一个提示符死掉，诊断路径——用原始 node-pty 对着 runner 的 pwsh 跑一遍——一次 CI 运行即可复现。
