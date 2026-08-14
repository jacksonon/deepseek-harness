# DeepSeek Harness Desktop (Electron shell)

English | [中文](README.zh.md)

A fully standalone Electron desktop app for the DeepSeek Harness Web GUI.
The harness server runtime (`@deepseek-ai/dsh`) is bundled as a real
dependency and booted under Electron's own Node (`ELECTRON_RUN_AS_NODE`),
so the target machine needs **no** `dsh` CLI and **no** Node installation —
install the app, open it, and it runs its own private server on an
OS-assigned free port (never colliding with an already-running `dsh web`),
loads the GUI in a locked-down `BrowserWindow`, and terminates the server
when the window closes.

This directory is deliberately **not** a pnpm-workspace member: it is a
self-contained npm package, so it cannot interfere with other workstreams in
the repository (the workspace's strict `allowBuilds` gate would otherwise
require touching `pnpm-workspace.yaml`).

## Requirements

- Nothing beyond the app itself. An internet connection and an API key are
  needed to talk to the model provider — enter the key in the GUI (Settings →
  Models) or configure the usual dsh channels (env / `DSH_HOME`).

## Quick start (from a checkout)

```sh
cd desktop
npm install
npm start
```

The window shows the same GUI as `dsh web` in a browser — including
`window.__DSH_BOOT__` injection and the /api transport — because the bundled
server is the real server.

## Environment variables (development/testing only)

| Variable                  | Meaning                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------ |
| `DSH_DESKTOP_DASH`        | Spawn this executable instead of the bundled server (e.g. a repository checkout's CLI).    |
| `DSH_DESKTOP_EXTRA_ARGS`  | Space-separated extra flags passed to `dsh web` (e.g. `--trusted-host app.internal:3080`).  |
| `DSH_DESKTOP_SMOKE`       | `1` = self-check: boot, load, print `DSH_DESKTOP_SMOKE_OK <url>`, exit 0 (fail: exit 1).    |

## Packaging

```sh
npm run dist            # dmg + zip (macOS arm64+x64), nsis (Windows x64), AppImage (Linux)
npm run dist:dir        # unpacked app only, for a quick check
```

Artifacts land in `desktop/dist/`. The packaged app is standalone — the
`dsh` server runtime ships inside it. `asar` is disabled so the bundled
server and its native modules ship as plain files.

The `dependencies` list deliberately names every `@deepseek-ai` plugin the
bundled runtime imports, including ones the harness packages only declare as
`peerDependencies` (for example `@deepseek-ai/cordis-plugin-group`): the
electron-builder npm collector packages the app's own dependency tree and
drops peer-only packages, so a plugin that is only a peer would boot fine in
a checkout and crash clean machines with `ERR_MODULE_NOT_FOUND`. Add a plugin
here whenever the bundled server needs it at runtime.

## How it works

1. The main process resolves the bundled CLI entry
   (`node_modules/@deepseek-ai/dsh/lib/bin.js`).
2. It spawns `process.execPath` with `ELECTRON_RUN_AS_NODE=1` and
   `--expose-internals` (required by the harness HMR plugin; Electron forbids
   that flag in `NODE_OPTIONS`, but honors it as a command-line node flag),
   passing `web --port 0`, and parses the readiness line
   `dsh web: http://127.0.0.1:<port>`.
3. It opens a 1280×840 window (context isolation, no node integration,
   sandboxed renderer), loads the server URL, and blocks navigation to any
   other origin.
4. External `http(s)` links open in the system browser.
5. Closing the window (or SIGINT/SIGTERM) SIGTERMs the server and quits.
   A server crash mid-session shows an error dialog and closes the app.

## CI release

`.github/workflows/desktop-release.yml` builds and publishes the macOS and
Windows apps on native runners, smoke-tests the packaged artifacts in place,
and uploads them to the GitHub Release of the pushed `v*` tag. See the
workflow header for signing/notarization secrets and the manual-dispatch
flow. The TUI CLI release has a reserved slot in that workflow.
