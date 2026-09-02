# Agent Note: 桌面预配跳过加固

Status: implemented

[English](2026-08-27-desktop-provision-skip-hardening.md) | 中文

## Problem

`desktop-v0.1.1-rc.1-0.1` 随版发布的"二次启动跳过"要求桌面自管运行时 Node（`runtime\node\node.exe`）与 pnpm（`runtime\pnpm-global\pnpm.cmd`）必须存在。首启预配若采用了本机已有工具链——最常见的是 nvm 管理的 `node.exe`——这些路径永远不会被创建，于是检查在每次启动都失败，每个启动都重跑完整流程：删除 harness 树、从安装包源码重新拷贝、再对整个 workspace 跑联网的 `pnpm install --prod`（boot 日志实测 20–150 秒）。用户反馈描述的正是这个状态：每次启动都付出环境检测的代价。

另有两个次要缺口让修复真正触发时代价更高。manifest 对记录的 Node 二进制按字节大小做同一性判断，nvm 符号链接重新指向另一个已装版本就被当作漂移，即使新二进制完全可启动也强制全量重建；播种逻辑在重新拷贝前无条件删除目标树，丢弃已完成的安装。WSL 预配则完全没有复用：`ensure_wsl_runtime` 每次启动都重跑 `pnpm install`。

boot 日志后来在同一组守卫上暴露出第三个缺口：它们把 `node_modules/.pnpm` 的存在当作安装完成的证明，但 pnpm 在链接过程中就创建该存储，`node_modules/.modules.yaml` 要到结束才写入。一次被中途杀掉的安装——20 分钟上限、应用退出、崩溃——会留下一个通过所有判定的存储，被吞掉的安装失败接着写入 manifest，让后续每次启动都走快速通道。Host 随后在每次启动都死于 `ERR_MODULE_NOT_FOUND`（`Cannot find package '@deepseek-ai/dsh-app-boot'`），只能手工删除缓存；当内容性失败（一条未使用的 `node-pty` patch 条目）中止全新安装时，恢复路径也可能采纳这样一棵残缺的树。

## Decision

复用改为以实际构建产物为准。manifest 记录的 Node 路径仍是跳过预配的权威依据；与 `nodeBytes` 的字节一致只是快速通道。字节不一致（符号链接改指向的情形）时，用一次引擎范围探测裁决：兼容的版本直接接受、不重配，不兼容的才落入正常的扫描/下载路径。预配过程内部，可启动的树（预构建 CLI 入口加一次完成的安装）绝不重新播种，已完成的安装——`.pnpm` 存储加 pnpm 的结束标记 `node_modules/.modules.yaml`——才跳过 `pnpm install`；因此一次修复只重建真正缺失的那一块。安装失败且标记缺失时，启动进入恢复路径而不是吞掉错误，半链接的存储不再可能被记录成已预配。WSL 预配通过 `test -d` 与 `test -f` 探测存储与标记并应用同样的跳过。三种启动模式共享同一条规则：为该 bundle 哈希完成过的工作在后续启动中被引用，而不是重做。

由于磁盘上的判定看不见一次完成安装之后的存储损伤，Windows 启动还会依据 Host 自己的诊断做修复：Host 退出且 stderr 指名一个无法解析的依赖（`ERR_MODULE_NOT_FOUND` / `Cannot find package` / `Cannot find module`）时，删除预配树与 manifest 一次，并在同一次启动内重新预配，然后才向上报错。位于 harness 树内的桌面 overlay 补丁文件在每次尝试时重新植入。

本记录拥有复用守卫、记录 Node 的同一性策略与缺依赖修复。预配模型仍由[跨平台桌面源码预配](../feature/2026-08-14-cross-platform-desktop-source-provisioning.zh.md)拥有。

## Alternatives considered

**接受字节漂移且不做探测。** 否决：PATH 变化换到范围外的 Node 会通过复用检查，然后 Host 在会话中途崩溃；单次探测把保障成本控制在每次真实漂移约 100 毫秒。

**改记规范化后的 Node 路径而非漂移时探测。** 否决：用户环境中 junction、symlink 与普通安装并存，canonical 解析行为各异；引擎范围探测则直接回答漂移后的二进制能否启动。

**在预配阶段通过解析或执行 CLI 的 import 图来证明可解析性。** 否决：import CLI 入口等于启动 Host，而重新实现裸说明符解析是在复刻 Node 的解析器；pnpm 自己的结束标记加 Host 退出修复，在不执行任何东西的前提下给出同样的保障。

## Consequences

后续启动引用为当前 bundle 哈希已完成的预配工作而不是重做：被采纳的本机 Node 通过一次引擎范围探测即可复用，可启动树在修复中得以保留，已完成的安装跳过 `pnpm install`，WSL 预配应用同样的跳过规则。一次成功预配后的二次启动开销只剩 manifest 读取加单次探测；真实的漂移——Node 符号链接重指向到支持范围外的版本——回退到正常的扫描/下载路径，而不是用一个不兼容的运行时启动。存储创建之后被打断的安装现在让自己那次启动失败、下次启动重装，而不是毒化 manifest、让之后每次启动都死于 `ERR_MODULE_NOT_FOUND`；同一自修复也覆盖标记看不见的损伤，代价是修复触发时付出一次完整的重播种加安装。
