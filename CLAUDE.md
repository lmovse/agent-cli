# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is an Obsidian plugin that embeds AI agent terminals (Claude CLI, Gemini CLI, Codex CLI) directly into the Obsidian sidebar. It uses xterm.js for terminal rendering and a Python PTY bridge to spawn shell processes.

## Build Commands

- **Development**: `npm run dev` - Runs esbuild in watch mode for incremental builds
- **Production build**: `npm run build` - Runs TypeScript type check (`tsc -noEmit -skipLibCheck`) then esbuild production bundle

## Architecture

The plugin follows a typical Obsidian plugin structure:

```
Obsidian App
├── AgentCLIPlugin (main.ts)
│   ├── Registers TerminalView as sidebar item
│   ├── Adds ribbon icon and commands
│   └── Manages settings persistence
├── TerminalView (TerminalView.ts)
│   ├── Creates xterm.js terminal
│   ├── Spawns Python PTY process with agent command
│   ├── Handles terminal I/O streams
│   └── Auto-detects Obsidian dark/light theme
├── SettingTab (SettingTab.ts)
│   └── Provides Obsidian settings UI
└── settings.ts
    └── Defines settings interface and defaults
```

## Key Implementation Details

### PTY Bridge

The terminal connects to the AI agent via a Python PTY. The Python script is embedded inline in `TerminalView.ts:209-242` (the `startAgent` method). It:

1. Uses `pty.fork()` to create a pseudo-terminal
2. Spawns `/bin/zsh` in the PTY
3. Writes the agent command to the PTY after a brief delay
4. Uses `selectors` to multiplex stdin/stdout between xterm.js and the PTY

### Settings Storage

Settings are persisted via Obsidian's `loadData()`/`saveData()` API. The default settings in `settings.ts` are merged with stored settings on load.

### Terminal Theme Sync

The terminal detects Obsidian's theme by checking `document.body.classList.contains('theme-dark')` and applies corresponding colors to xterm.js.

## Supported Agents

- Claude CLI (`claude`)
- Gemini CLI (`gemini`)
- Codex CLI (`codex`)

Each agent has configurable command, display name, and enabled state in settings.

## Important Notes

- The plugin is desktop-only (requires system terminal access)
- Requires Obsidian v0.15.0+
- The Python script uses hardcoded `/usr/bin/python3` path
- PATH is extended to include common locations: `/usr/local/bin`, `/usr/bin`, `/opt/homebrew/bin`, etc.
