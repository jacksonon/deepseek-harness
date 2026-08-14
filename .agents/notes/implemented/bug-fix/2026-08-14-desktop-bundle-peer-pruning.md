# Agent Note: The desktop app shipped without the peer-only plugins its bundled server imports

Status: implemented

English | [中文](2026-08-14-desktop-bundle-peer-pruning.zh.md)

## Problem

The v0.1.0 desktop app crashed at boot on clean machines with `ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/cordis-plugin-group'`: the bundled `dsh` server exited before printing its readiness line, in the official Windows installer and in the mac build alike. The packaged app's `node_modules` lacked `cordis-plugin-group` and 18 further `@deepseek-ai` packages, even though every referenced plugin resolved during development and in CI.

Two causes compounded:

1. **electron-builder packages only the app's own `dependencies` tree and drops peer-only packages.** The harness packages declare their plugin seams as `peerDependencies` (`dsh-app-boot` → `cordis-plugin-group`, `dsh-commands` → `dsh-scope`, and so on). `npm ci` auto-installs those peers into the desktop app's `node_modules`, but the electron-builder npm collector prunes everything not reachable through `dependencies` fields, so every runtime-imported peer was missing from the packaged app.
2. **The CI smoke tests ran the packaged app inside the repo checkout, masking the missing packages.** Node resolves the bundled server's imports by walking `node_modules` upward from the app bundle; from `desktop/dist/...` that walk falls through to the checkout's `desktop/node_modules`, where the peers exist. Both the mac and the Windows smoke passed. Only a clean machine — or the same app copied outside the repo — reproduces the crash.

## Decision

- `desktop/package.json` declares every `@deepseek-ai` package the bundled runtime imports as a direct `dependencies` entry: `@deepseek-ai/cordis-plugin-group` plus the 18 other peer-only packages that static-import analysis and the out-of-checkout boot found missing (`dsh-anonymous-user-id`, `dsh-atomic-write`, `dsh-bash-local`, `dsh-code-runtime`, `dsh-compaction`, `dsh-fs`, `dsh-invariants`, `dsh-output-retention`, `dsh-sandbox`, `dsh-scope`, `dsh-session-telemetry`, `dsh-session-title-llm`, `dsh-shell`, `dsh-spill`, `dsh-subagent-in-process-driver`, `dsh-subprocess`, `dsh-timeout`, `dsh-workflow`). This is the leaf-consumer side of the peer contract: the harness packages keep their peers as peers, and the standalone app — which cannot rely on any ambient installation — pins the ones it needs.
- Both release-workflow smoke steps (mac and Windows) copy the packaged app to `$RUNNER_TEMP` and run it from there, so the boot can no longer fall through to the checkout's `node_modules`.

## Alternatives considered

**Promote the peers to `dependencies` inside the harness packages themselves.** Correct for a bundling consumer, but it changes every package's published manifest for one leaf app, and the repo's peer convention exists so multiple consumers can share a single cordis instance. Rejected as out of scope for the desktop fix.

**Add the missing packages to the desktop `devDependencies` and disable pruning.** devDependencies are not packaged, and the electron-builder npm collector has no switch to keep peer-only packages of the app's own tree. Not viable.

**Keep the in-checkout smoke and add a static completeness check over the packaged `node_modules`.** A static check would have caught this bug, but the out-of-checkout smoke covers the same ground end-to-end (ESM imports, loader-time `name:` resolution, and native-module loading) with less machinery. The smoke is the gate.

## Consequences

The packaged app grows by the 19 small plugin packages (a few MB). Any future peer-only plugin the bundled runtime starts importing must be added to `desktop/package.json`; the README documents the rule, and the out-of-checkout smoke fails the release if it is forgotten. The in-checkout `npm run smoke` still resolves peers from the dev `node_modules` and cannot validate the bundle — only the packaged-app smoke from a clean path does.

## Testing

- Reproduced the user crash: the v0.1.0 packaged mac app run from `/tmp` fails with the exact `ERR_MODULE_NOT_FOUND` for `@deepseek-ai/cordis-plugin-group` (the same failure the official Windows installer exhibits — its archive contains zero `cordis-plugin-group` files).
- After the fix: the rebuilt app run from `/tmp` boots the server, loads the GUI, and prints `DSH_DESKTOP_SMOKE_OK` with exit 0; the in-repo smoke stays green.
- The full reference set (all 134 `name:` entries in the packaged `dsh-base`/`dsh-web-app` patch layers and the agent presets) is present in the packaged `node_modules`.
