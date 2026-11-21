# Sable

Sable is a desktop app for working with coding agents. It runs the Claude Code and Codex CLIs you already have installed and signed in, and gives both one calm place to work.

- A conversation that shows what the agent is doing without drowning you in tool calls.
- Answers that can hold charts, diagrams and small interactive views.
- A side panel with your changes, files, a browser, a terminal and the agent's sub-agents.
- A phone app to follow and steer your chats from anywhere.

Sable has no model and no account of its own. Your agents do the work; Sable shows it.

![A finished turn with a chart in the answer](docs/session.png)

## Contents

- [What Sable does](#what-sable-does)
- [How it is built](#how-it-is-built)
- [For AI agents working on this repo](#for-ai-agents-working-on-this-repo)
- [Install](#install)
- [The phone app](#the-phone-app)
- [Requirements](#requirements)
- [Development](#development)
- [Trademarks and license](#trademarks-and-license)

## What Sable does

### A conversation you can follow

While a turn runs you see one live line: what the agent is doing now, the time, and how many steps. The agent's own short reports appear as they come in. The steps fold behind that line and open with one click, in their places. A message you send while the agent works is answered right below it, and the work goes on. When the turn ends, the line becomes a summary with the time it took and the files it changed, above the answer.

![A live turn and the Changes panel](docs/live.png)

### Two agents that work together

- **Sub-agents across agents.** Each agent can hand a task to the other. A Claude Code session can ask Codex, and the other way round. The sub-agent's steps show under the step that started it.
- **Check with the other agent.** Under a finished turn that changed files, "Check with Codex" (or Claude Code) reviews the changes read-only and puts its findings in your composer.
- **Switch agent in place.** Move a chat from one agent to the other. Each keeps its own conversation, and the one coming in gets a short handover.
- **Race.** `/race <task>` gives the same task to two agents or two models at once, each in its own copy of the repository, side by side. Keep the better result with one click.

![A race: two models on one task, side by side, each ready to keep](docs/race.png)

### The agent can answer with an interface

Both agents get a `show_widget` tool. When a chart, a diagram, a small form or a simulation explains something better than prose, the agent draws it and it appears inline. Widgets run in a sandboxed frame with no network access and no access to Sable or your files. Answers also draw `mermaid` diagrams, preview `html` and `svg` code blocks, and lay out wide tables. Files the agent hands you appear as cards you can open.

![An answer with two files handed over as cards](docs/files.png)

### Several accounts per agent, and their limits in view

Add as many Claude Code or Codex accounts as you use and switch between them from the sidebar, which shows how much of each plan window is used. Set a cap per account ("use this one up to 90%"). When a turn hits a cap or a plan limit, Sable continues the same conversation on the next account in your order. Spare quota that would expire unused can run queued work (`/spare`), and a chat stopped at a limit can continue by itself when the window resets.

![The account switcher with one account's limits](docs/accounts.png)

### Usage you can read

Settings › Usage shows each account's plan windows, when they reset and whether you are on pace. It also shows the tokens your agents used by day, model, project and session, read from the transcripts the agents already keep on disk.

![Settings, Usage](docs/usage.png)

### Your phone as a remote

The Android app pairs with Sable by QR code. It shows your chats, their live progress and everything waiting on you. You can answer permissions and questions, send or steer messages, start new chats, and get a notification when a turn finishes or needs you. It talks to your computer directly over your home network, or over [Tailscale](https://tailscale.com) when you are away. Nothing goes through a server of ours.

### Everything else

- **One timeline for both agents:** messages, thinking, commands, file edits with diffs, searches, sub-agents, workflows, MCP tools, plans and todos.
- **Review comments** on diffs. Comment on lines in the Changes tab or an edit step, then send them all to the agent as one review.
- **Conversation map** along the right edge: a tick per message you sent, a preview on hover, Alt+Up/Down to step through them.
- **Project scripts** in the Terminal tab ("Run dev"). A local address a dev server prints opens in the Browser tab with one click.
- **Triage deck** (Ctrl+I): every permission and question waiting across all chats, answered by keyboard.
- **`/until <check>`**: the agent keeps going until your check passes (tests, a build, a linter), within a number of rounds and a usage budget.
- **Before and after:** a local page in the Browser tab is captured before and after a turn that edits files, with changed regions marked and a compare slider.
- **Lanes (optional):** a chat that starts in a git folder where another chat is working gets its own worktree and branch. The Changes tab says whether it lands cleanly before you land it.
- **Projects** that group folders, chats without a folder, and a sidebar you arrange by drag.
- **Input:** permission cards with diff previews, question cards, queueing and steering, slash commands and skills (`/`), file mentions (`@`), shell commands (`!`), attachments and images.
- **Per-session controls:** model, permission mode, thinking level and speed.
- **Side panel:** git changes, file tree, a browser with tabs, a terminal, tasks, context usage, the chat's agents, and an Android device or emulator for app work.
- **History:** browse and resume the conversations your agents keep on disk. Rewind to an earlier message, optionally restoring files.
- **Profile:** `~/.sable/profile.md` holds facts about you that both agents read and can add to.
- **Long chats stay fast:** chats of hundreds of megabytes open in seconds and stream without slowing the app.
- **Keep awake:** the computer does not sleep while an agent works, or while a paired phone may need it and it is plugged in.
- **Quiet system messages:** background tasks and slash commands that Claude Code writes into a chat show as quiet lines with their result.
- **Appearance:** liquid glass on floating layers (composer, menus, dialogs) over a dithered backdrop that reacts to sends, finished turns and failures. Presets, your own image, and a live editor in Settings › Appearance.

![Settings, Appearance](docs/appearance.png)

![Two review comments on a diff, and the review bar above the composer](docs/review.png)

The screenshots use Sable's built-in Demo agent with made-up projects and accounts.

## How it is built

Sable is one process. Vite serves the interface, and a **bridge** (the `server/` folder) is attached to the same process. The bridge owns all state. The interface is a view: it calls RPC methods and applies the events the bridge sends back over a WebSocket at `/__sable`.

```
Electron shell (electron/)        window, menus, auto-update, keep-awake
        |
Bridge (server/)                  sessions, accounts, limits, providers, services
   |  providers/   claude.ts (Claude Agent SDK), codex.ts (codex app-server), demo.ts
   |  core/        runtime (timeline, prompts, queue), limit policy, lanes, race, check
   |  services/    files, git, terminal, usage, limits, phone, devices, updates
        |  WebSocket /__sable, RPC methods defined in shared/protocol.ts
Interface (src/)                  React 19 + TypeScript + zustand
   |  state/       store, actions (everything the UI may ask the bridge), hooks
   |  features/    one folder per area (timeline, composer, rail, sidebar, settings...)
   |  ui/, icons/, art/, styles/   primitives, icons, backdrop and motion, tokens
Phone app (mobile/)               Capacitor + React, talks to the bridge's phone service
```

Every agent is normalised into one timeline model (`TimelineItem`: user, text, thinking, tool, notice, turn). The interface never branches on the provider except for marks and colour.

Main entry points:

| Concern | Where |
| --- | --- |
| Shared contract (RPC methods, types) | `shared/protocol.ts` |
| Bridge, RPC handlers, sessions | `server/app.ts` |
| Session timeline and queue | `server/core/runtime.ts` |
| Limits and account switching | `server/core/limit-policy.ts` |
| Claude Code provider | `server/providers/claude.ts` |
| Codex provider | `server/providers/codex.ts` |
| Demo provider (scripted, no quota) | `server/providers/demo.ts` |
| Conversation view (turns, steps, live line) | `src/features/timeline/` |
| Store and actions | `src/state/store.ts`, `src/state/actions.ts` |
| Design tokens and primitives | `src/styles/tokens.css`, `src/styles/ui.css`, `src/ui/` |
| Phone app | `mobile/src/` |

## For AI agents working on this repo

If you are an agent, read [CLAUDE.md](CLAUDE.md) first. It holds the architecture notes, the working rules, and the design language, which is strict: monochrome surfaces, no new colours, no emoji, sentence case, and no decoration on controls.

Ground rules that matter most:

- **Do not start a second dev server.** `pnpm dev` is usually already on `http://localhost:5173`, or `5174`. Reuse it. `pnpm dev` uses the real profile in `~/.sable`, so for tests and screenshots use `node scripts/dev-test.mjs`, which uses a throwaway folder.
- **Build and test against the Demo provider.** Real Claude or Codex turns spend the owner's quota. The smoke scripts (`scripts/claude-smoke.ts`, `scripts/codex-smoke.ts`) also cost quota, so do not run them without an explicit go-ahead.
- **Shared files need a reason.** `shared/`, `src/state`, `src/styles`, `src/ui`, `src/icons`, `src/art` and `src/app` are shared; change them only when the task calls for it.
- **Use the store correctly.** Subscribe narrowly (`useStore(s => s.data[id]?.items[itemId])`). Items are immutable: change one by replacing it. Use `rev` or `changedSince`, never item identity, to detect changes.
- **Platform guards.** Windows-only and macOS-only calls sit behind a `process.platform` check. Never touch signing identities.
- **Check before you finish:** `pnpm typecheck` and `pnpm test`. For UI work, look at the result: `node scripts/shot.mjs` takes headless screenshots, and `http://localhost:5173/?gallery` shows every control in every state.

Useful commands:

```sh
pnpm dev                              # interface and bridge, real profile
node scripts/dev-test.mjs             # same server on a throwaway profile
pnpm typecheck                        # tsc --noEmit over the whole project
pnpm test                             # vitest
node scripts/perf-headless.mjs        # work per interaction, against the dev server
pnpm desktop:pack                     # unpacked Windows build in release/
```

Browser console helpers in dev builds: `sable.demo('<prompt>')` opens a Demo session, `sable.store.getState()` reads the store and `sable.actions` lists what the UI can do.

## Install

### Windows

Download `Sable-Setup-<version>.exe` from the [Releases page](https://github.com/Leonxlnx/sable/releases) and run it. It installs for your user only, with no admin prompt, and opens Sable when it finishes.

The installer is not code-signed, so Windows SmartScreen warns on first run. Choose "More info", then "Run anyway". From 0.2.5 on, Sable updates itself: it checks the Releases page now and then, downloads a new version in the background, and shows "Restart to update" in the sidebar and in Settings › About. Installing 0.2.5 itself is a manual download.

### macOS (experimental)

Download `Sable-<version>-mac-arm64.dmg` (Apple silicon) or `Sable-<version>-mac-x64.dmg` (Intel) from the same release, and drag Sable onto Applications. The app is signed ad hoc and not notarized by Apple, so macOS blocks the first start:

1. Open Sable from Applications once. macOS says it cannot verify the app. Choose "Done".
2. Open System Settings › Privacy & Security, find the message about Sable, choose "Open Anyway" and confirm. This is needed once per installed version.

Or, in a terminal, once: `xattr -dr com.apple.quarantine /Applications/Sable.app`.

On a Mac, Sable behaves like any Mac app. Closing the window keeps it in the Dock with your agents still working, and Cmd replaces Ctrl in every shortcut. It finds Claude Code, Codex and your tools through your login shell. This build has not been tried on many Macs yet; please open an issue with your macOS version and chip if something is off.

Sable keeps its data in `~/.sable`. The uninstaller leaves that folder alone.

## The phone app

1. Download `Sable-Android-<version>.apk` from the same release and open it on your Android phone. Android asks once to allow installs from that source. The app is not on the Play Store.
2. In Sable on your computer, open Settings › Phone, turn phone access on and choose "Pair a phone". Scan the code with the app and allow the phone on the computer.
3. The phone reaches the computer on the same Wi-Fi. To use it away from home, install [Tailscale](https://tailscale.com) on both, signed in to the same account, and open the app once at home afterwards. It learns the computer's Tailscale address by itself. Keep the computer on and plugged in, because closing a laptop's lid usually puts it to sleep.

A newer APK installs over the old one and keeps the pairing.

## Requirements

- Windows 10 or 11, or a recent macOS (experimental).
- Claude Code and/or the Codex CLI, installed and signed in. Sable uses their own sign-in and never sees your password or tokens. Plan limits are asked of the agents themselves, and usage is counted from their transcripts.
- For the phone app: Android 7 or newer.

## Development

You need Node 22 or newer and pnpm.

```sh
pnpm install
pnpm dev                  # http://localhost:5173, with the bridge attached
pnpm test                 # vitest
pnpm typecheck
pnpm desktop:dist         # Windows installer in release/
pnpm desktop:dist:mac     # on a Mac: disk image and zip for this Mac's chip
```

The Mac app can only be built on a Mac. The "macOS build" workflow (`.github/workflows/mac.yml`) builds both chips on GitHub's Macs, checks the signature and the bundled agent, starts the app once, and can attach the files to a release. Each chip builds natively because the Claude Code binary comes from the Agent SDK's package for that chip.

`pnpm dev` runs on your real profile. For experiments, `node scripts/dev-test.mjs` starts the same server on a throwaway folder. `pnpm desktop:pack` builds `release/win-unpacked/Sable.exe` without an installer.

The phone app lives in `mobile/`. `npm install` and `npm run apk` there build a debug APK (needs the Android SDK and a JDK 21). `npm run dev` serves it in a browser for quick work.

Architecture, conventions and design rules are in [CLAUDE.md](CLAUDE.md).

## Trademarks and license

Sable is an independent project and is not affiliated with or endorsed by Anthropic or OpenAI. Claude and Claude Code are trademarks of Anthropic. OpenAI and Codex are trademarks of OpenAI. The Claude and Codex marks shown next to each agent come from [`@lobehub/icons-static-svg`](https://github.com/lobehub/lobe-icons) (MIT) and are used only to identify those products.

Released under the [MIT License](LICENSE).
