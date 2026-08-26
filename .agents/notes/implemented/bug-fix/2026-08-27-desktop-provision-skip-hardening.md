# Agent Note: Desktop provision skip hardening

Status: implemented

English | [中文](2026-08-27-desktop-provision-skip-hardening.zh.md)

## Problem

The repeat-boot skip shipped in `desktop-v0.1.1-rc.1-0.1` required the desktop-managed runtime Node (`runtime\node\node.exe`) and pnpm (`runtime\pnpm-global\pnpm.cmd`) to exist. A first-run provision that adopted a host toolchain — an nvm-managed `node.exe` being the common case — never creates those paths, so the check failed on every launch and each start re-ran the full flow: delete the harness tree, recopy it from the bundled source, and run a networked `pnpm install --prod` over the whole workspace (20–150 s observed in boot logs). User feedback described exactly this state: every launch pays the environment-detection cost.

Two secondary holes made repair expensive when it did fire. Byte-size identity on the recorded Node binary treated an nvm symlink repoint to another installed version as drift, forcing a full rebuild even though the new binary boots fine; and seeding unconditionally removed the destination tree before recopying, discarding a completed install. WSL provisioning had no reuse at all: `ensure_wsl_runtime` re-ran `pnpm install` on every launch.

## Decision

Reuse now keys on what was actually built. The manifest's recorded Node path stays the authority for a skipped provision; byte equality with `nodeBytes` is only a fast path. When bytes differ (the symlink-repoint case), one engine-range probe of that binary decides — compatible versions are accepted without reprovisioning, unsupported ones fall into the normal scan/download path. Inside provisioning itself, a bootable tree (prebuilt CLI entry plus `node_modules/.pnpm`) is never re-seeded, and an existing dependency store skips `pnpm install`; a repair therefore rebuilds only whichever piece is genuinely missing. WSL provisioning probes the same store through `test -d` and applies the identical skip, so all three launch modes share one rule: work completed for this bundle hash is referenced on later launches, never redone.

This note owns the reuse guards and the recorded-Node identity policy. The provisioning model remains owned by [cross-platform desktop source provisioning](../feature/2026-08-14-cross-platform-desktop-source-provisioning.md).

## Alternatives considered

**Accept byte drift without any probe.** Rejected: a PATH change to an outside-range Node would pass reuse and crash the Host mid-session; the single probe keeps the boot guarantee at roughly 100 ms once per actual drift.

**Record the canonicalized Node path instead of probing on drift.** Rejected: canonical resolution behaves differently across junctions, symlinks, and plain installs that users actually have, while the engine-range probe answers directly whether the drifted binary can boot.
