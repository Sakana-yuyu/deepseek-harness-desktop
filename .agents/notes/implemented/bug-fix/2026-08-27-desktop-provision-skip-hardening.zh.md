# Agent Note: 桌面预配跳过加固

Status: implemented

[English](2026-08-27-desktop-provision-skip-hardening.md) | 中文

## Problem

`desktop-v0.1.1-rc.1-0.1` 随版发布的"二次启动跳过"要求桌面自管运行时 Node（`runtime\node\node.exe`）与 pnpm（`runtime\pnpm-global\pnpm.cmd`）必须存在。首启预配若采用了本机已有工具链——最常见的是 nvm 管理的 `node.exe`——这些路径永远不会被创建，于是检查在每次启动都失败，每个启动都重跑完整流程：删除 harness 树、从安装包源码重新拷贝、再对整个 workspace 跑联网的 `pnpm install --prod`（boot 日志实测 20–150 秒）。用户反馈描述的正是这个状态：每次启动都付出环境检测的代价。

另有两个次要缺口让修复真正触发时代价更高。manifest 对记录的 Node 二进制按字节大小做同一性判断，nvm 符号链接重新指向另一个已装版本就被当作漂移，即使新二进制完全可启动也强制全量重建；播种逻辑在重新拷贝前无条件删除目标树，丢弃已完成的安装。WSL 预配则完全没有复用：`ensure_wsl_runtime` 每次启动都重跑 `pnpm install`。

## Decision

复用改为以实际构建产物为准。manifest 记录的 Node 路径仍是跳过预配的权威依据；与 `nodeBytes` 的字节一致只是快速通道。字节不一致（符号链接改指向的情形）时，用一次引擎范围探测裁决：兼容的版本直接接受、不重配，不兼容的才落入正常的扫描/下载路径。预配过程内部，可启动的树（预构建 CLI 入口加 `node_modules/.pnpm`）绝不重新播种，依赖存储已存在就跳过 `pnpm install`；因此一次修复只重建真正缺失的那一块。WSL 预配通过 `test -d` 探测同一个存储并应用同样的跳过。三种启动模式共享同一条规则：为该 bundle 哈希完成过的工作在后续启动中被引用，而不是重做。

本记录拥有复用守卫与记录 Node 的同一性策略。预配模型仍由[跨平台桌面源码预配](../feature/2026-08-14-cross-platform-desktop-source-provisioning.zh.md)拥有。

## Alternatives considered

**接受字节漂移且不做探测。** 否决：PATH 变化换到范围外的 Node 会通过复用检查，然后 Host 在会话中途崩溃；单次探测把保障成本控制在每次真实漂移约 100 毫秒。

**改记规范化后的 Node 路径而非漂移时探测。** 否决：用户环境中 junction、symlink 与普通安装并存，canonical 解析行为各异；引擎范围探测则直接回答漂移后的二进制能否启动。

## Consequences

后续启动引用为当前 bundle 哈希已完成的预配工作而不是重做：被采纳的本机 Node 通过一次引擎范围探测即可复用，可启动树在修复中得以保留，已有依赖存储跳过 `pnpm install`，WSL 预配应用同样的跳过规则。一次成功预配后的二次启动开销只剩 manifest 读取加单次探测；真实的漂移——Node 符号链接重指向到支持范围外的版本——回退到正常的扫描/下载路径，而不是用一个不兼容的运行时启动。
