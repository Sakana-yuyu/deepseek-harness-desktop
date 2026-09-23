# Agent Note: Desktop bundle strips unbundled workspace dependencies

Status: implemented

English | [中文](2026-09-24-desktop-bundle-strips-unbundled-workspace-deps.zh.md)

## Problem

The desktop installer ships a trimmed harness tree: `bundle-harness-source.mjs` copies `apps/cli`, `apps/web`, `native/system`, `vendor/*`, and `packages/*/*` while skipping whole package groups (`examples`, `test-support`, `experimental`). First launch provisions the tree with `pnpm install --prod`, which resolves every `workspace:*` dependency against the copied workspace only.

Upstream `apps/cli` now declares `@deepseek-ai/dsh-experimental-agent-team-profile` and `@deepseek-ai/dsh-experimental-voice-input-bundle` as regular `dependencies`. Both live in the skipped `experimental` group, so provisioning aborted with `ERR_PNPM_WORKSPACE_PKG_NOT_FOUND` before the Host ever started. Skipping a package group is no longer sufficient when a shipped manifest names one of its packages.

## Decision

- After copying, the bundler walks the trimmed tree, collects the `name` of every workspace member it actually ships, and drops dependency entries that use the `workspace:` protocol but name an absent package. The pass covers `dependencies`, `optionalDependencies`, and `peerDependencies`, and removes a section left empty. Registry-range dependencies are never touched.
- Stripping happens at bundle time on the bundled manifests only; the repository workspace is unchanged. This keeps the shipped slice to the web profile the desktop app launches, instead of pulling the nine transitive experimental packages — and their optional native dependencies — into every first-run install.
- The manifest hash continues to hash the source slices, so it still changes whenever bundled content changes; the strip is a deterministic function of that content.
- If a future profile resolves one of the stripped bundles at runtime, resolution fails loud, and the fix is to move that package out of a skipped group, not to special-case the bundle.

## Consequences

- First-run provisioning succeeds again on upstream manifests that reference experimental packages.
- Experimental bundles stay absent from the desktop distribution, matching every earlier release; enabling them in the desktop app is a packaging decision, not an install-time accident.
