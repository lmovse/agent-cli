# Agent CLI

An Obsidian plugin that integrates AI agent terminals (Claude, Gemini, Codex) directly into your Obsidian sidebar.

## Features

- **Embedded Terminal** - Run AI agent CLI directly in Obsidian's sidebar
- **Multi-Agent Support** - Support for Claude CLI, Gemini CLI, and Codex CLI
- **Theme Auto-Detection** - Automatically matches Obsidian's dark/light theme
- **Current File Context** - Automatically send current file path to agent
- **Customizable Terminal** - Adjust font size and family to your preference

## Installation

### Option 1: Direct Installation (Recommended for Development)

1. Build the plugin:

   ```bash
   cd agent-cli
   npm run build
   ```

2. Copy the plugin folder to your Obsidian plugins directory:

   ```bash
   cp -r /path/to/agent-cli ~/.obsidian/plugins/agent-cli
   ```

3. Open Obsidian, go to **Settings → Community Plugins**, and enable "Agent CLI"

### Option 2: BRAT Installation

1. Install the [BRAT](https://obsidian.md/plugins?search=brat) plugin
2. Use BRAT to add this repository: `https://github.com/lmovse/obsidian-agent-cli`
3. Enable the plugin in Obsidian

## Usage

### Opening the Terminal

Click the robot icon in the right sidebar ribbon to open the Agent Terminal.

### Commands

The following commands are available via the Obsidian command palette:

- **Open Agent Terminal** - Open the terminal view
- **Switch Agent** - Cycle between enabled agents
- **Restart Agent** - Restart the current agent
- **Send Current File to Agent** - Send current file path to the agent

### Settings

Configure the plugin in **Settings → Agent CLI**:

- **Default Agent** - Choose which AI agent to use by default
- **Agent Configuration** - Enable/disable agents, customize commands and display names
- **Font Size** - Adjust terminal font size (10-24px)
- **Font Family** - Set terminal font family
- **Auto-send Current File** - Automatically send current file path when opening terminal
- **Test Agent Connections** - Verify that configured agents are accessible

## Supported Agents

- **Claude CLI** - Anthropic's AI assistant
- **Gemini CLI** - Google's AI model
- **Codex CLI** - OpenAI's Codex model

## Requirements

- Obsidian v0.15.0 or later
- Desktop-only (requires system terminal access)
- At least one AI agent CLI installed and available in your PATH

## License

MIT
