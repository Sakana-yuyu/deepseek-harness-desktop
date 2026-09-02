# Agent Note: Desktop provision skip hardening

Status: implemented

English | [中文](2026-08-27-desktop-provision-skip-hardening.zh.md)

## Problem

The repeat-boot skip shipped in `desktop-v0.1.1-rc.1-0.1` required the desktop-managed runtime Node (`runtime\node\node.exe`) and pnpm (`runtime\pnpm-global\pnpm.cmd`) to exist. A first-run provision that adopted a host toolchain — an nvm-managed `node.exe` being the common case — never creates those paths, so the check failed on every launch and each start re-ran the full flow: delete the harness tree, recopy it from the bundled source, and run a networked `pnpm install --prod` over the whole workspace (20–150 s observed in boot logs). User feedback described exactly this state: every launch pays the environment-detection cost.

Two secondary holes made repair expensive when it did fire. Byte-size identity on the recorded Node binary treated an nvm symlink repoint to another installed version as drift, forcing a full rebuild even though the new binary boots fine; and seeding unconditionally removed the destination tree before recopying, discarding a completed install. WSL provisioning had no reuse at all: `ensure_wsl_runtime` re-ran `pnpm install` on every launch.

Boot logs later surfaced a third hole in the same guards: they read `node_modules/.pnpm` existence as proof of a completed install, but pnpm creates that store during linking and writes `node_modules/.modules.yaml` only at the end. An install killed mid-link — the 20-minute ceiling, an app quit, a crash — left a store that passed every gate, and the swallowed install failure then wrote a manifest that fast-pathed every later boot. The Host died on `ERR_MODULE_NOT_FOUND` (`Cannot find package '@deepseek-ai/dsh-app-boot'`) on every launch until the cache was deleted by hand; recovery could also adopt such a tree when a content failure (an unused `node-pty` patch entry) aborted the fresh install.

## Decision

Reuse now keys on what was actually built. The manifest's recorded Node path stays the authority for a skipped provision; byte equality with `nodeBytes` is only a fast path. When bytes differ (the symlink-repoint case), one engine-range probe of that binary decides — compatible versions are accepted without reprovisioning, unsupported ones fall into the normal scan/download path. Inside provisioning itself, a bootable tree (prebuilt CLI entry plus a completed install) is never re-seeded, and a completed install — the `.pnpm` store plus pnpm's end-of-install marker `node_modules/.modules.yaml` — skips `pnpm install`; a repair therefore rebuilds only whichever piece is genuinely missing. An install failure without the marker fails the boot into recovery instead of being swallowed, so a half-linked store can no longer be recorded as provisioned. WSL provisioning probes the store and marker through `test -d` and `test -f` and applies the identical skip, so all three launch modes share one rule: work completed for this bundle hash is referenced on later launches, never redone.

Because the on-disk gates cannot see store damage after a completed install, the Windows boot also repairs from the Host's own diagnosis: a Host exit whose stderr names an unresolvable dependency (`ERR_MODULE_NOT_FOUND` / `Cannot find package` / `Cannot find module`) deletes the provisioned tree and manifest once and re-provisions in the same boot before surfacing the failure. The desktop overlay patch file, which lives inside the harness tree, is re-implanted on each attempt.

This note owns the reuse guards, the recorded-Node identity policy, and the missing-dependency repair. The provisioning model remains owned by [cross-platform desktop source provisioning](../feature/2026-08-14-cross-platform-desktop-source-provisioning.md).

## Alternatives considered

**Accept byte drift without any probe.** Rejected: a PATH change to an outside-range Node would pass reuse and crash the Host mid-session; the single probe keeps the boot guarantee at roughly 100 ms once per actual drift.

**Record the canonicalized Node path instead of probing on drift.** Rejected: canonical resolution behaves differently across junctions, symlinks, and plain installs that users actually have, while the engine-range probe answers directly whether the drifted binary can boot.

**Prove resolvability at provision time by resolving or executing the CLI's import graph.** Rejected: importing the CLI entry boots the Host, and reimplementing bare-specifier resolution duplicates Node's resolver; pnpm's own end-of-install marker plus the Host-death repair deliver the same guarantee without executing anything.

## Consequences

Later launches reference the work completed for the recorded bundle hash instead of redoing it: an adopted host Node passes reuse after one engine-range probe, a bootable tree survives repair, a completed install skips `pnpm install`, and WSL provisioning applies the same skip. The repeat-boot cost after one successful provision is the manifest read plus the probe; a genuine drift — a Node repoint outside the supported engine range — falls back to the normal scan/download path instead of booting an incompatible runtime. An install interrupted after the store was created now fails its own boot and is reinstalled on the next launch, instead of poisoning the manifest and failing every later boot with `ERR_MODULE_NOT_FOUND`; the same self-repair covers damage the marker cannot see, at the cost of a full reseed and install whenever the repair fires.
