# Claude Telegram

Control Claude Code sessions from your phone via Telegram. A background daemon that bridges Claude Code CLI to Telegram with per-project worker bots.

## How It Works

There are two types of bots:

1. **Manager Bot** — The one you already set up (`@hodgesz_claude_control_bot`). It manages your worker bots. You only need one of these.

2. **Worker Bots** — One per project. Each worker bot is a separate Telegram bot connected to a specific project directory on your machine. When you send it a message, it runs Claude Code in that directory.

```
You (Telegram) → Manager Bot → /add worker bot
You (Telegram) → Worker Bot → Claude Code (in project dir) → response back
```

## Quick Start

### 1. Create a Worker Bot

Go to [@BotFather](https://t.me/BotFather) on Telegram and create a new bot:
- Send `/newbot`
- Give it a name like "My Project Bot"
- Give it a username like `my_project_worker_bot`
- Copy the API token it gives you

### 2. Add the Worker Bot to Your Manager

Send this to your **Manager Bot** (`@hodgesz_claude_control_bot`):

```
/add <worker-bot-token> /path/to/your/project
```

For example:
```
/add 123456789:ABCdefGHI /Users/jonathanhodges/VsCodeProjects/my-project
```

Or just send `/add` and it'll walk you through it step by step.

### 3. Start Coding from Telegram

Open the **Worker Bot** you just created and send it any message:
- `"Fix the login bug in auth.ts"` — Claude Code will work on it
- `"What does the handleSubmit function do?"` — Ask questions about your code
- Send a **photo or file** — Claude will use it as context

## Worker Bot Commands

| Command | What it does |
|---------|-------------|
| _(any message)_ | Send to Claude Code as a prompt |
| _(photo/file)_ | Attach as context for Claude |
| `/new` | Start a fresh conversation |
| `/model` | Switch between Opus, Sonnet, Haiku |
| `/cost` | Show token usage and cost for this session |
| `/status` | Check if a terminal session is active or idle |
| `/session` | Get the session ID (for resuming in CLI) |
| `/resume` | Resume a CLI session in Telegram |
| `/cancel` | Stop the current operation |
| `/yolo` | Toggle auto-approve mode (no tool confirmations) |
| `/preview <port>` | Open an ngrok tunnel to localhost |
| `/close` | Close the ngrok tunnel |
| `/schedule "text"` | Schedule a recurring task (natural language) |
| `/schedules` | List your scheduled tasks |
| `/unschedule <id>` | Remove a scheduled task |
| `/help` | Show all commands |

## Manager Bot Commands

| Command | What it does |
|---------|-------------|
| `/add TOKEN /path` | Add a worker bot for a project |
| `/add` | Add a worker bot (interactive, step by step) |
| `/bots` | List all active worker bots |
| `/remove @botname` | Remove a worker bot |
| `/schedules` | List all scheduled tasks across all bots |
| `/cancel` | Cancel the current /add flow |

## Key Features

### Session Continuity

Sessions are stored as JSONL transcript files in `~/.claude/projects/{project-path}/`. Both terminal and Telegram sessions write to this same location, which means you can hand off work between devices freely.

**How resume works:** When you `/resume` a session (or `claude --resume` in terminal), the SDK reads the full JSONL transcript and loads all prior messages as context, then starts a new process that continues from that point. It's a fork of the conversation — the original session isn't "taken over," it's branched from.

**Terminal → Telegram:**
1. Work in terminal: `claude` → do some work
2. Finish or leave the session idle
3. In Telegram worker bot: `/resume` → see recent sessions with timestamps and previews → tap to continue

**Telegram → Terminal:**
1. Work in Telegram worker bot → do some work
2. Send `/session` → get the session ID
3. In terminal: `claude --resume <session-id>` → full Telegram conversation history is loaded

To skip tool approval prompts when resuming in the terminal, add `--dangerously-skip-permissions`:
```
claude --resume <session-id> --dangerously-skip-permissions
```

**Full round-trip:**
```
Terminal → /resume in Telegram → more work → /session → claude --resume in terminal
```
Each hop reads the latest transcript state. As long as you finish or idle one side before resuming on the other, it's a clean handoff.

**Important:** If both sides are actively running at the same time, they fork — edits diverge and you may get file conflicts since both processes write to the same project directory. To avoid this, `/cancel` or finish the active session before resuming on the other side.

### Long-Running Tasks on the Go

If you're kicking off a task that might take a while (big refactors, migrations, test suites), **start it from Telegram instead of the terminal**. This gives you full remote control:

- Permission prompts arrive as tap-to-approve buttons on your phone
- You can respond to questions or provide input from anywhere
- Streaming updates show you what Claude is doing in real time
- `/cancel` stops it remotely if something goes wrong

A running terminal session can't be controlled from Telegram — the terminal process owns stdin/stdout exclusively. Use `/status` to check if a terminal session is still running or has finished, and `/resume` to pick it up once it's idle.

**Recommended workflow for long tasks:**
```
1. Open Telegram worker bot
2. Send the task: "refactor the auth module to use JWT"
3. Walk away — approve tools from your phone as needed
4. When done, /session gives you the ID to continue in terminal later
```

### Monitoring Terminal Sessions

Use `/status` to check on the most recent session for this project:
- 🟢 **Active** — Claude is still working in the terminal. Don't resume yet.
- 🟡 **Just finished** — activity within the last 30 seconds. Safe to resume shortly.
- 💤 **Idle** — done. Safe to `/resume` from Telegram.

### Tool Approval
When Claude wants to run a command or edit a file, you'll get an inline keyboard:
- **Approve** — allow this one time
- **Always** — allow this tool for the rest of the session
- **Deny** — block it

Use `/yolo` to skip all approvals (auto-approve everything).

### Scheduled Tasks
Use natural language to schedule recurring tasks:
```
/schedule "run the test suite every morning at 9am"
/schedule "check for security vulnerabilities every Monday"
```

Claude parses the schedule, shows you a preview, and asks for confirmation. Tasks persist across daemon restarts.

### Localhost Preview
If you're running a dev server:
```
/preview 3000
```
Opens an ngrok tunnel so you can access `localhost:3000` from your phone. Auto-closes after 30 minutes of inactivity. Requires an ngrok auth token (set during `claude-telegram setup`).

## CLI Reference

| Command | Description |
|---------|-------------|
| `claude-telegram setup` | Configure bot token, owner ID, options |
| `claude-telegram start` | Start the background daemon |
| `claude-telegram stop` | Stop the daemon |
| `claude-telegram status` | Check if daemon is running |
| `claude-telegram logs` | Tail daemon logs (live) |
| `claude-telegram install-service` | Auto-start on login (macOS launchd / Linux systemd) |
| `claude-telegram uninstall-service` | Remove auto-start service |

## Architecture

```
~/.clautel/
├── config.json          # Bot token, owner ID, ngrok token
├── bots.json            # Worker bot configs [{id, token, username, workingDir}]
├── schedules.json       # Scheduled tasks
├── daemon.pid           # Running daemon PID
├── app.log              # Daemon logs (rotates at 5MB)
└── {botId}-state.json   # Per-bot session state (tokens, models, sessions)
```

The daemon is a single Node.js process that runs all bots via long polling (no public URL needed). Each worker bot runs Claude Code in its assigned project directory using the official Claude Code SDK.

## Requirements

- Node.js 18+
- Claude Code with a valid API key (Anthropic direct, AWS Bedrock, or Google Vertex)
- Telegram account
