import { Plugin, MarkdownView, WorkspaceLeaf } from 'obsidian';
import { AgentCLIPluginSettings, DEFAULT_SETTINGS, AgentType } from './settings';
import { TerminalView, AGENT_TERMINAL_VIEW } from './TerminalView';
import { SettingTab } from './SettingTab';

export default class AgentCLIPlugin extends Plugin {
  settings: AgentCLIPluginSettings;

  async onload() {
    // Load settings
    await this.loadSettings();

    // Register the terminal view
    this.registerView(
      AGENT_TERMINAL_VIEW,
      (leaf) => new TerminalView(leaf, this)
    );

    // Add sidebar button with robot icon (appears in right sidebar after Outline)
    this.addRibbonIcon('bot', 'Agent Terminal', () => {
      this.activateView();
    });

    // Add commands
    this.addCommand({
      id: 'open-terminal',
      name: 'Open Agent Terminal',
      callback: () => {
        this.activateView();
      },
    });

    this.addCommand({
      id: 'send-to-terminal',
      name: 'Send selection to terminal',
      editorCallback: (editor, view) => {
        const selection = editor.getSelection();
        if (selection) {
          this.sendToTerminal(selection);
        }
      },
    });

    // Add command to switch agent
    this.addCommand({
      id: 'switch-agent',
      name: 'Switch Agent',
      callback: async () => {
        const leaves = this.app.workspace.getLeavesOfType(AGENT_TERMINAL_VIEW);
        if (leaves.length > 0) {
          const view = leaves[0].view as TerminalView;
          await view.openAgentSelector();
        }
      },
    });

    // Add command to restart agent
    this.addCommand({
      id: 'restart-agent',
      name: 'Restart Agent',
      callback: async () => {
        const leaves = this.app.workspace.getLeavesOfType(AGENT_TERMINAL_VIEW);
        if (leaves.length > 0) {
          const view = leaves[0].view as TerminalView;
          await view.restartAgent();
        }
      },
    });

    // Add command to send current file
    this.addCommand({
      id: 'send-current-file',
      name: 'Send Current File to Agent',
      callback: async () => {
        const leaves = this.app.workspace.getLeavesOfType(AGENT_TERMINAL_VIEW);
        if (leaves.length > 0) {
          const view = leaves[0].view as TerminalView;
          await view.sendCurrentFile();
        }
      },
    });

    // Add settings tab
    this.addSettingTab(new SettingTab(this.app, this));
  }

  onunload() {
    this.app.workspace.detachLeavesOfType(AGENT_TERMINAL_VIEW);
  }

  async loadSettings() {
    this.settings = Object.assign(
      {},
      DEFAULT_SETTINGS,
      await this.loadData()
    );
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async activateView() {
    const { workspace } = this.app;

    // Try to get existing leaf or create new one
    let leaf: WorkspaceLeaf | null = null;
    const existingLeaves = workspace.getLeavesOfType(AGENT_TERMINAL_VIEW);

    if (existingLeaves.length > 0) {
      leaf = existingLeaves[0];
    } else {
      // Try to get right leaf without creating new one (will reuse existing if available)
      leaf = workspace.getRightLeaf(false);

      if (leaf) {
        // Check if it's already our view
        if (leaf.view && leaf.view.getViewType() === AGENT_TERMINAL_VIEW) {
          // Already our view, do nothing
        } else {
          // Replace with our terminal view
          await leaf.setViewState({
            type: AGENT_TERMINAL_VIEW,
            active: true,
          });
        }
      } else {
        // No existing leaf, create new one
        leaf = workspace.getRightLeaf(true);
        if (leaf) {
          await leaf.setViewState({
            type: AGENT_TERMINAL_VIEW,
            active: true,
          });
        }
      }
    }

    if (leaf) {
      workspace.revealLeaf(leaf);
    }
  }

  async sendToTerminal(text: string) {
    const leaves = this.app.workspace.getLeavesOfType(AGENT_TERMINAL_VIEW);
    if (leaves.length > 0) {
      const view = leaves[0].view as TerminalView;
      view.sendToAgent(text);
    } else {
      await this.activateView();
      // Small delay to ensure terminal is ready
      setTimeout(() => {
        const leaves = this.app.workspace.getLeavesOfType(AGENT_TERMINAL_VIEW);
        if (leaves.length > 0) {
          const view = leaves[0].view as TerminalView;
          view.sendToAgent(text);
        }
      }, 500);
    }
  }

  getCurrentFileContent(): Promise<string> {
    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile) return Promise.resolve('');

    return this.app.vault.read(activeFile);
  }

  getCurrentFilePath(): string {
    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile) return '';

    return activeFile.path;
  }

  getSelectedText(): string {
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (activeView) {
      return activeView.editor.getSelection();
    }
    return '';
  }
}
