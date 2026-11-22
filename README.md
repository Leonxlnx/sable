# Sable

Sable is a desktop app for working with coding agents. It runs the Claude Code and Codex CLIs you already have installed and signed in (and OpenCode, where you have it), and gives them one calm place to work: a conversation that shows what the agent is doing without drowning you in tool calls, answers that can hold charts and small interactive views, a side panel with your changes, files, a browser, a terminal and the agent's sub-agents, and a phone app to follow and steer your chats from anywhere. Sable has no model or account of its own. Your agents do the work; Sable shows it.

![A finished turn with a chart in the answer](docs/session.png)

## What is different

**A conversation you can follow.** While a turn runs you see one live line (what the agent is doing now, the time, how many steps) and the agent's own short reports as they come in. The steps fold behind that line and open with one click, in their places. A message you send while the agent works is answered right below it, and the work goes on. When the turn ends, the line becomes a summary with the time it took and the files it changed, above the answer.

![A live turn and the Changes panel](docs/live.png)

**Two agents that work together.** Each agent can hand a task to the other as a sub-agent: a Claude Code session can ask Codex, and the other way round, and the sub-agent's steps show under the step that started it. Under a finished turn that changed files, "Check with Codex" (or Claude Code) lets the other agent review the changes read-only and puts its findings in your composer. Switch a chat from one agent to the other in place: each keeps its own conversation, and the one coming in gets a short handover. And `/race <task>` gives the same task to both at once, each in its own copy of the repository, side by side; keep the better result with one click.

![A race: two models on one task, side by side, each ready to keep](docs/race.png)

**The agent can answer with an interface.** Both agents get a `show_widget` tool. When a chart, a diagram, a small form or a simulation explains something better than prose, the agent draws it and it appears inline in the answer. Widgets run in a sandboxed frame with no network access and no access to Sable or your files. Answers also draw `mermaid` diagrams, preview `html` and `svg` code blocks, and lay out wide tables properly. Files the agent hands you show up as cards you can open.

![An answer with two files handed over as cards](docs/files.png)

**Your phone as a remote.** The Android app pairs with Sable by QR code and shows your chats, their live progress and everything that waits on you. Answer permissions and questions, send or steer messages, start new chats, and get a notification when a turn finishes or needs you. It talks to your computer directly over your home network (or [Tailscale](https://tailscale.com) when you are away); nothing goes through a server of ours.

**Several accounts per agent, and their limits in view.** Add as many Claude Code or Codex accounts as you use and switch between them from the sidebar, which shows how much of each plan window is used. Accounts are listed in the order to use them: the one whose unused week ends soonest first, so the least quota expires unused (or your own order, if you prefer). Set a cap per account ("use this one up to 90%"), and when a turn hits a cap or a plan limit, Sable continues the same conversation on the next account. A big conversation is compacted on the account it leaves first, where that is cheaper, and the switch line says what the move did to its context. Spare quota that would expire unused can run queued work (`/spare`), and a chat stopped at a limit can continue by itself when the window resets. When Claude Code has a limit reset for you, Sable opens Claude Code's own reset dialog in a window of its own (on a Mac, it gives you the command), you confirm there, and Sable reads the limits again; it never touches your sign-in.

![The account switcher with one account's limits](docs/accounts.png)

**Usage you can read.** Settings › Usage shows each account's plan windows with when they reset and whether you are on pace, plus the tokens your agents used by day, model, project and session, read from the transcripts the agents already keep on disk.

![Settings, Usage](docs/usage.png)

## Everything else

Review comments on diffs: comment on lines in the Changes tab or an edit step, then send all of them to the agent as one review.

![Two review comments on a diff, and the review bar above the composer](docs/review.png)

- Claude Code (through the Claude Agent SDK), Codex (through `codex app-server`) and, where it is installed, OpenCode (through `opencode acp`, on its free models or the providers you signed it in to) in one timeline: messages, thinking, commands, file edits with diffs, searches, sub-agents and workflows, MCP tools, plans and todos.
- A navigator for long conversations along the right edge: your messages gathered into runs, and an index of every one of them (rest on the rail or Ctrl+G, type to filter). Alt+Up/Down steps through them.
- A message sent while the agent works is answered first, in a sentence or two, before it goes on (Claude Code and Codex).
- Sub-agents that keep working after a turn ends show in the sidebar and under the conversation, and the computer stays awake and updates wait until they finish.
- Customize Sable: ask an agent (`/customize`, or Settings › Customize) to change how Sable looks. It writes your own stylesheet, applied live and kept across updates; a stylesheet that would load anything from the internet is not applied. Start with `--original` (or hold Shift) for Sable's own look.
- Project scripts in the Terminal tab ("Run dev"), and a local address a dev server prints opens in the Browser tab with one click.
- A triage deck (Ctrl+I) with every permission and question waiting across all chats, answered by keyboard.
- `/until <check>`: the agent keeps going until your check passes (tests, a build, a linter), within a number of rounds and a usage budget.
- Before and after: a local page in the Browser tab is captured before and after a turn that edits files, with the changed regions marked and a compare slider.
- Lanes (optional): a chat that starts in a git folder where another chat is working gets its own worktree and branch, and the Changes tab says whether it lands cleanly before you land it.
- Projects that group folders, chats without a folder, and a sidebar you arrange by drag.
- Permission cards with diff previews, question cards, queueing and steering, slash commands and skills (`/`), file mentions (`@`), shell commands (`!`), attachments and images.
- Model, permission mode, thinking level and speed per session, including Ultracode for Claude and the ultra level for Codex.
- Side panel: git changes, file tree, a browser with tabs next to the conversation, a terminal, tasks, context usage, the agents of the chat, and an Android device or emulator for app work.
- Pull requests from the Changes tab: once the working tree is clean, "Create pull request" shows the branch, every address it is pushed to, the commits that go and the repository it opens in, then pushes exactly that and opens it with the GitHub CLI (`gh`). Git, `gh` and the terminal's shell are never run from inside the project folder. A commit message can be drafted from the changes by the chat's own agent and account (one small request, on your click).
- A toast when an agent's plan window nears or reaches its limit, once no other account of that agent has room. Pictures in answers and messages open larger on click. On home, the branch chip switches between a repository's worktrees.
- History: browse and resume the conversations your agents keep on disk. Rewind to an earlier message, optionally restoring files.
- A profile of you (`~/.sable/profile.md`) that both agents read and can add short facts to.
- Long chats stay fast: chats of hundreds of megabytes open in seconds and stream without slowing the app.
- The computer does not go to sleep while an agent works, or while a paired phone may need it and it is plugged in.
- Background tasks, agents and slash commands Claude Code writes into a chat show as quiet lines with their result, not as raw text.
- Calm frosted glass on what floats (the composer, menus, dialogs) and flat controls, over a dithered backdrop that reacts when you send, when a turn ends and when something fails, and goes still when you stop. Presets, your own image and a live editor in Settings › Appearance.

![Settings, Appearance](docs/appearance.png)

The screenshots use Sable's built-in Demo agent with its made-up project and accounts.

## Install

### Windows

Download `Sable-Setup-<version>.exe` from the [Releases page](https://github.com/Leonxlnx/sable/releases) and run it. It installs for your user only, with no admin prompt, and opens Sable when it finishes.

The installer is not code-signed, so Windows SmartScreen warns on first run: choose "More info", then "Run anyway". From 0.2.5 on, Sable updates itself: it checks the Releases page now and then, downloads a new version in the background, and shows "Restart to update" in the sidebar (also in Settings › About). Installing 0.2.5 itself is a manual download.

### macOS (experimental)

Download `Sable-<version>-mac-arm64.dmg` (Apple silicon) or `Sable-<version>-mac-x64.dmg` (Intel) from the same release and drag Sable onto Applications. The app is signed ad hoc and not notarized by Apple, so macOS blocks the first start:

1. Open Sable from Applications once. macOS says it cannot verify the app. Choose "Done".
2. Open System Settings › Privacy & Security, find the message about Sable, choose "Open Anyway" and confirm. This is needed once per installed version.

Or, in a terminal, once: `xattr -dr com.apple.quarantine /Applications/Sable.app`.

On a Mac, closing the window keeps Sable in the Dock with your agents still working, and Cmd replaces Ctrl in every shortcut. Sable finds Claude Code, Codex and your tools through your login shell, and updates itself from the release's zip. The Mac build was written and checked without a Mac and has not been tried on many yet: please open an issue with your macOS version and chip if something is off.

Sable keeps its data in `~/.sable`. The uninstaller leaves that folder alone.

### The phone app

1. Download `Sable-Android-<version>.apk` from the same release onto your Android phone and open it. Android asks once to allow installs from that source (the app is not on the Play Store).
2. In Sable on your computer, open Settings › Phone, turn phone access on and choose "Pair a phone". Scan the code with the app and allow the phone on the computer.
3. The phone reaches the computer on the same Wi-Fi. To use it away from home, install [Tailscale](https://tailscale.com) on both, signed in to the same account, and open the app once at home afterwards: it learns the computer's Tailscale address by itself. Keep the computer on and plugged in (closing a laptop's lid usually puts it to sleep).

A newer APK installs over the old one and keeps the pairing.

## Requirements

- Windows 10 or 11, or a recent macOS (experimental).
- Claude Code and/or the Codex CLI, installed and signed in (OpenCode is optional). Sable uses their own sign-in and never sees your password or tokens: plan limits are asked of the agents themselves, and usage is counted from their transcripts.
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

The Mac app can only be built on a Mac. The "macOS build" workflow (`.github/workflows/mac.yml`) builds both chips on GitHub's Macs, checks the signature and the bundled agent, starts the app once, and can attach the files to a release.

`pnpm dev` runs on your real profile (`~/.sable`). For experiments, `node scripts/dev-test.mjs` starts the same server on a throwaway folder. `pnpm desktop:pack` builds `release/win-unpacked/Sable.exe` without an installer.

In a dev build the scripted Demo agent is available, so you can work on the interface without spending quota. In the browser console, `sable.demo('refactor the session module')` opens a Demo session and sends a prompt; keywords in the prompt pick what the Demo does, for example `chart`, `form`, `dashboard`, `agent`, `progress`, `fleet` or `marathon`.

The phone app lives in `mobile/` (Capacitor and React). `npm install` and `npm run apk` there build a debug APK (needs the Android SDK and a JDK 21); `npm run dev` serves it in a browser for quick work.

Architecture, conventions and design rules are in [CLAUDE.md](CLAUDE.md).

## How it is built

Sable is one process. Vite serves the interface, and a **bridge** (the `server/` folder) is attached to the same process. The bridge owns all state. The interface is a view: it calls RPC methods and applies the events the bridge sends back over a WebSocket at `/__sable`.

```
Electron shell (electron/)        window, menus, updates, keep-awake
        |
Bridge (server/)                  sessions, accounts, limits, providers, services
   |  providers/   claude.ts (Claude Agent SDK), codex.ts (codex app-server),
   |               opencode.ts (opencode acp), demo.ts (scripted)
   |  core/        runtime (timeline, prompts, queue, background work), limit policy,
   |               account moves, reset dialog, lanes, race, check, commit draft
   |  services/    files, git, pull requests, terminal, usage, limits, phone, devices,
   |               updates, customize
        |  WebSocket /__sable, RPC methods defined in shared/protocol.ts
Interface (src/)                  React 19 + TypeScript + zustand
   |  state/       store, actions (everything the UI may ask the bridge), hooks
   |  features/    one folder per area (timeline, composer, rail, sidebar, settings...)
   |  ui/, icons/, art/, styles/   primitives, icons, backdrop and motion, tokens
Phone app (mobile/)               Capacitor + React, talks to the bridge's phone service
```

Every agent is normalised into one timeline model (`TimelineItem`: user, text, thinking, tool, notice, turn). The interface never branches on the provider except for marks and colour.

| Concern | Where |
| --- | --- |
| Shared contract (RPC methods, types) | `shared/protocol.ts` |
| Bridge, RPC handlers, sessions | `server/app.ts` |
| Session timeline and queue | `server/core/runtime.ts` |
| Limits and account switching | `server/core/limit-policy.ts`, `server/accounts/folders.ts` |
| Account order (use first) | `shared/use-first.ts`, `src/features/accounts/order.ts` |
| Moving a chat to another account | `server/core/move-context.ts`, `server/accounts/handover.ts` |
| Limit reset in Claude Code's dialog | `server/core/reset-console.ts`, `server/util/console.ts` |
| Claude Code, Codex, OpenCode, Demo | `server/providers/claude.ts`, `codex.ts`, `opencode.ts`, `demo.ts` |
| Pull requests, commit draft | `server/services/pulls.ts`, `server/core/commit-draft.ts` |
| Customize Sable | `server/services/custom.ts`, `src/features/customize/` |
| Conversation view (turns, steps, live line, navigator) | `src/features/timeline/` |
| Store and actions | `src/state/store.ts`, `src/state/actions.ts` |
| Design tokens and primitives | `src/styles/tokens.css`, `src/styles/ui.css`, `src/ui/` |
| Phone app | `mobile/src/` |

## Notes for agents working on this repo

Read [CLAUDE.md](CLAUDE.md) first: the architecture notes, the working rules and the design language (monochrome surfaces, no new colours, no emoji, sentence case, no decoration on controls). The rules that matter most:

- **One dev server.** One is usually already running on `http://localhost:5173` (or 5174): reuse it. `pnpm dev` uses the real profile in `~/.sable`; for tests and screenshots use `node scripts/dev-test.mjs`, which uses a throwaway folder.
- **The Demo agent, not real turns.** Real Claude Code, Codex or OpenCode turns spend the owner's quota, and so do the smoke scripts in `scripts/`: run them only with an explicit go-ahead.
- **Shared files need a reason.** `shared/`, `src/state`, `src/styles`, `src/ui`, `src/icons`, `src/art` and `src/app` are shared; change them only when the task calls for it.
- **The store, narrowly.** Subscribe to what you show (`useStore(s => s.data[id]?.items[itemId])`). Items are immutable: change one by replacing it. Use `rev` or `changedSince`, never item identity, to see changes.
- **Platform guards.** Windows-only and macOS-only calls sit behind a `process.platform` check. Never touch signing identities.
- **Check before you finish:** `pnpm typecheck` and `pnpm test`. For interface work, look at the result: `node scripts/shot.mjs` takes headless screenshots, and `http://localhost:5173/?gallery` shows every control in every state.

## Trademarks

Sable is an independent project and is not affiliated with or endorsed by Anthropic or OpenAI. Claude and Claude Code are trademarks of Anthropic; OpenAI and Codex are trademarks of OpenAI. The Claude and Codex marks shown next to each agent come from [`@lobehub/icons-static-svg`](https://github.com/lobehub/lobe-icons) (MIT) and are used only to identify those products. OpenCode is an independent open-source project; its mark in Sable is plain geometry, used only to identify it.

## License

[MIT](LICENSE)
