# Agent Note: 桌面打包剔除未随附的 workspace 依赖

Status: implemented

[English](2026-09-24-desktop-bundle-strips-unbundled-workspace-deps.md) | 中文

## 问题

桌面安装包携带的是裁剪后的 harness 源码树：`bundle-harness-source.mjs` 复制 `apps/cli`、`apps/web`、`native/system`、`vendor/*` 与 `packages/*/*`，并整组跳过 `examples`、`test-support`、`experimental` 三个包组。首次启动用 `pnpm install --prod` 预配该树，而这个安装只针对裁剪后的 workspace 解析每一条 `workspace:*` 依赖。

上游 `apps/cli` 现在把 `@deepseek-ai/dsh-experimental-agent-team-profile` 与 `@deepseek-ai/dsh-experimental-voice-input-bundle` 声明为普通 `dependencies`。两者都位于被跳过的 `experimental` 组，于是预配在 Host 启动前就以 `ERR_PNPM_WORKSPACE_PKG_NOT_FOUND` 中止。当已随附的 manifest 点名某个被跳过组的包时，仅按组跳过已不再充分。

## 决策

- 复制完成后，打包器遍历裁剪树，收集实际随附的每个 workspace 成员的 `name`，并删除使用 `workspace:` 协议但指向缺席包的依赖条目。处理范围覆盖 `dependencies`、`optionalDependencies` 与 `peerDependencies`，被清空的段整个移除。registry 版本区间的依赖一律不动。
- 剔除只发生在打包时、只作用于打包树内的 manifest，仓库 workspace 不变。桌面应用启动的是 web profile，保持发行片只含它需要的部分，而不是把九个传递的 experimental 包及其可选原生依赖拖进每一次首次安装。
- manifest 哈希仍然对源码切片计算，因此打包内容变化时哈希照常变化；剔除是该内容的确定性函数。
- 若未来某个 profile 在运行时解析到被剔除的 bundle，解析会响亮失败；正确的修复是把该包移出被跳过的组，而不是给打包器开特例。

## 备选方案

- 连 experimental 组一起发行，让所有 `workspace:*` 引用都可解析。否决：这会把九个传递包及其可选原生依赖拖进每一次首次安装，而桌面 web profile 从不启动这些 bundle。
- 直接改写上游 manifest，删掉 experimental 依赖。否决：仓库 workspace 保持不变是既定原则；发行 manifest 与源 manifest 的差异必须仅由打包步骤可复现地产生。
- 保留 manifest 原样，用能从 npm registry 解析缺失包的锁文件做预配。否决：workspace 包不发布到 registry，回退解析同样会失败。

## 后果

- 上游 manifest 引用 experimental 包时，首次预配恢复正常。
- 桌面发行版继续不包含 experimental bundle，与此前所有版本一致；在桌面应用中启用它们属于打包决策，不会在安装时意外发生。
