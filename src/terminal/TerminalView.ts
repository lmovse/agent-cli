import { ItemView, WorkspaceLeaf, Notice } from 'obsidian';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type * as cp from 'child_process';
import { StringDecoder } from 'string_decoder';
import AgentCLIPlugin from '../main';
import { AgentCLIPluginSettings, AgentType, getEnabledAgents } from '../settings/settings';
import { spawnAgentProcess, stopAgentProcess } from './process';

export const AGENT_TERMINAL_VIEW = 'agent-terminal-view';

export class TerminalView extends ItemView {
  private terminal: Terminal;
  private fitAddon: FitAddon;
  private agentProcess: cp.ChildProcess | null = null;
  private outputProcess: cp.ChildProcess | null = null;
  private acceptingInput = false;
  private closed = false;
  private agentStartup: Promise<void> = Promise.resolve();
  private currentAgent: AgentType;
  private settings: AgentCLIPluginSettings;
  private cleanupCallbacks: (() => void)[] = [];
  private resizeObserver: ResizeObserver | null = null;

  constructor(leaf: WorkspaceLeaf, private plugin: AgentCLIPlugin) {
    super(leaf);
    // Load initial settings from plugin
    this.settings = plugin.settings;
    this.currentAgent = this.settings.defaultAgent;
  }

  // Method to refresh settings from plugin
  refreshSettings(): void {
    this.settings = this.plugin.settings;
  }

  getViewType(): string {
    return AGENT_TERMINAL_VIEW;
  }

  getDisplayText(): string {
    return 'Agent Terminal';
  }

  getDisplayName(): string {
    return 'Agent Terminal';
  }

  getIcon(): string {
    return 'bot';
  }

  async onOpen(): Promise<void> {
    this.closed = false;
    this.containerEl.empty();
    this.containerEl.classList.add('agent-terminal-container');

    this.createTerminal();
    this.trackActiveFile();
    await this.startAgent();
  }

  async onClose(): Promise<void> {
    this.closed = true;
    this.stopAgent();
    this.cleanupCallbacks.forEach(cb => cb());
    this.cleanupCallbacks = [];
    this.terminal.dispose();
  }

  override onResize(): void {
    // Terminal will resize automatically via ResizeObserver
  }

  private getAgentName(agentId: AgentType): string {
    return this.settings.agents[agentId]?.name || agentId;
  }

  private getCurrentTheme(): { background: string; foreground: string; cursor: string } {
    const isDarkTheme = document.body.classList.contains('theme-dark');
    return isDarkTheme
      ? {
        background: '#1e1e1e',
        foreground: '#d4d4d4',
        cursor: '#d4d4d4',
      }
      : {
        background: '#ffffff',
        foreground: '#333333',
        cursor: '#333333',
      };
  }

  private createTerminal(): void {
    const terminalContainer = this.containerEl.createDiv({ cls: 'terminal-wrapper' });

    // Use default rows, fit addon will adjust automatically
    this.terminal = new Terminal({
      fontSize: this.settings.terminalFontSize,
      fontFamily: this.settings.terminalFontFamily,
      theme: this.getCurrentTheme(),
      cursorBlink: true,
      convertEol: true,
      rows: 24,
      allowProposedApi: true,
      macOptionIsMeta: true,
      scrollback: 1000,
    });

    // Load and fit the terminal to container
    this.fitAddon = new FitAddon();
    this.terminal.loadAddon(this.fitAddon);
    this.terminal.open(terminalContainer);
    this.fitAddon.fit();

    // Clear any uninitialized buffer content (fixes W issue)
    this.terminal.clear();

    // Handle terminal input - send to process
    this.terminal.onData((data) => {
      this.sendToProcess(data);
    });

    // Sync PTY size when xterm.js resizes
    this.terminal.onResize(({ cols, rows }) => {
      this.sendResizeToProcess(cols, rows);
    });

    // Resize observer to adjust terminal size using fit addon
    this.resizeObserver = new ResizeObserver(() => {
      this.fitAddon.fit();
    });
    this.resizeObserver.observe(terminalContainer);
    this.cleanupCallbacks.push(() => {
      this.resizeObserver?.disconnect();
    });

    // Listen for theme changes
    const themeObserver = new MutationObserver(() => {
      if (this.terminal) {
        this.terminal.options.theme = this.getCurrentTheme();
      }
    });
    themeObserver.observe(document.body, {
      attributes: true,
      attributeFilter: ['class'],
    });
    this.cleanupCallbacks.push(() => {
      themeObserver.disconnect();
    });

    // Show loading indicator
    const loadingChars = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    let loadingIndex = 0;
    const loadingInterval = setInterval(() => {
      this.terminal.write(`\r\x1b[2K\x1b[90m${loadingChars[loadingIndex]} Connecting to ${this.currentAgent}...\x1b[0m`);
      loadingIndex = (loadingIndex + 1) % loadingChars.length;
    }, 80);

    // Store loading interval for cleanup
    (this as any).loadingInterval = loadingInterval;

    // Auto-focus the terminal
    this.terminal.focus();
  }

  private sendResizeToProcess(cols: number, rows: number): void {
    if (this.agentProcess && this.agentProcess.stdin) {
      this.agentProcess.stdin.write(`\x00RESIZE:${cols}:${rows}\n`);
    }
  }

  private trackActiveFile(): void {
    const callback = () => {
      // File tracking handled in initializeContext
    };
    this.app.workspace.on('active-leaf-change', callback);
    this.cleanupCallbacks.push(() => {
      this.app.workspace.off('active-leaf-change', callback);
    });
  }

  async sendCurrentFile(): Promise<void> {
    await this.agentStartup;
    if (this.closed) return;
    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile) {
      new Notice('No file is currently open', 3000);
      return;
    }

    // Send vault-relative path to terminal (no notification)
    if (this.acceptingInput && this.agentProcess?.stdin) {
      this.agentProcess.stdin.write(`@${activeFile.path} `);
    }
  }

  async sendToAgent(text: string): Promise<void> {
    await this.agentStartup;
    if (this.closed) return;
    if (!this.acceptingInput || !this.agentProcess) {
      this.terminal.writeln('\x1b[31m⚠️ Agent process not running. Please restart.\x1b[0m');
      return;
    }

    if (this.agentProcess.stdin) {
      this.agentProcess.stdin.write(text + '\r\n');
    }
  }

  private sendToProcess(data: string): void {
    if (this.agentProcess && this.agentProcess.stdin) {
      this.agentProcess.stdin.write(data);
    }
  }

  private clearLoadingIndicator(): void {
    const loadingInterval = (this as any).loadingInterval;
    if (!loadingInterval) return;

    clearInterval(loadingInterval);
    (this as any).loadingInterval = null;
    this.terminal.write('\r\x1b[2K');
  }

  private async startAgent(): Promise<void> {
    if (this.closed) return;
    this.refreshSettings();
    const enabledAgents = getEnabledAgents(this.settings);
    if (!enabledAgents.length) {
      this.stopAgent();
      this.terminal.writeln('No agents are enabled. Enable an agent in settings.');
      return;
    }
    if (!enabledAgents.includes(this.currentAgent)) {
      this.currentAgent = enabledAgents.includes(this.settings.defaultAgent)
        ? this.settings.defaultAgent : enabledAgents[0];
    }
    const agentConfig = this.settings.agents[this.currentAgent];
    if (!agentConfig.command.trim()) {
      this.clearLoadingIndicator();
      this.terminal.writeln('Set an agent command in settings before starting.');
      return;
    }

    try {
      const vaultCwd = (this.app.vault.adapter as any).basePath || this.app.vault.getRoot().path;
      const agentProcess = spawnAgentProcess(
        agentConfig.command, vaultCwd, this.terminal.cols, this.terminal.rows,
      );
      this.agentProcess = agentProcess;
      this.outputProcess = agentProcess;
      this.acceptingInput = false;
      const stdoutDecoder = new StringDecoder('utf8');
      const stderrDecoder = new StringDecoder('utf8');
      const writeOutput = (text: string): void => {
        if (this.outputProcess !== agentProcess || !text) return;
        this.clearLoadingIndicator();
        this.terminal.write(text);
        setTimeout(() => {
          if (this.outputProcess === agentProcess) this.terminal.scrollToBottom();
        }, 10);
      };
      agentProcess.stdout?.on('data', (data: Buffer) => writeOutput(stdoutDecoder.write(data)));
      agentProcess.stderr?.on('data', (data: Buffer) => writeOutput(stderrDecoder.write(data)));
      agentProcess.stdin?.on('error', () => {
        if (this.agentProcess === agentProcess) this.stopAgent();
      });
      agentProcess.on('exit', () => {
        if (this.agentProcess !== agentProcess) return;
        this.agentProcess = null;
        this.acceptingInput = false;
        this.clearLoadingIndicator();
      });
      agentProcess.on('close', (code: number | null) => {
        if (this.outputProcess !== agentProcess) return;
        writeOutput(stdoutDecoder.end());
        writeOutput(stderrDecoder.end());
        this.outputProcess = null;
        if (this.agentProcess === agentProcess) this.agentProcess = null;
        this.acceptingInput = false;
        this.clearLoadingIndicator();
        if (code !== 0 && code !== null) {
          this.terminal.writeln(`\r\n\x1b[33mAgent process exited with code ${code}\x1b[0m`);
        }
      });

      this.agentStartup = new Promise<void>((resolve) => {
        agentProcess.once('spawn', () => {
          if (this.agentProcess === agentProcess) {
            this.acceptingInput = true;
            this.clearLoadingIndicator();
          }
          resolve();
        });
        agentProcess.on('error', (error: Error) => {
          if (this.outputProcess === agentProcess) {
            this.agentProcess = null;
            this.acceptingInput = false;
            this.clearLoadingIndicator();
            this.terminal.writeln(`Failed to start ${agentConfig.name}: ${error.message}`);
          }
          resolve();
        });
      });
      await this.agentStartup;
      if (this.agentProcess !== agentProcess || !this.acceptingInput) return;
      if (this.settings.welcomeMessage) this.terminal.writeln(this.settings.welcomeMessage);
      if (this.settings.autoSendCurrentFile && this.app.workspace.getActiveFile()) {
        await this.sendCurrentFile();
      }
    } catch (error) {
      this.stopAgent();
      this.terminal.writeln(`Failed to start ${agentConfig.name}: ${(error as Error).message}`);
    }
  }

  stopAgent(): void {
    const agentProcess = this.agentProcess || this.outputProcess;
    this.agentProcess = null;
    this.outputProcess = null;
    this.acceptingInput = false;
    this.clearLoadingIndicator();
    if (agentProcess) stopAgentProcess(agentProcess);
  }

  async restartAgent(): Promise<void> {
    this.stopAgent();
    await this.startAgent();
  }

  async openAgentSelector(): Promise<void> {
    // Cycle through enabled agents
    this.refreshSettings();
    const enabledAgents = getEnabledAgents(this.settings);
    if (!enabledAgents.length) {
      this.stopAgent();
      new Notice('No agents are enabled. Enable an agent in settings.', 3000);
      return;
    }

    const currentIndex = enabledAgents.indexOf(this.currentAgent);
    const nextIndex = (currentIndex + 1) % enabledAgents.length;
    this.currentAgent = enabledAgents[nextIndex];

    await this.restartAgent();
  }

  updateSettings(): void {
    this.refreshSettings();
    if (this.terminal && this.fitAddon) {
      this.terminal.options.fontSize = this.settings.terminalFontSize;
      this.terminal.options.fontFamily = this.settings.terminalFontFamily;
      // Re-fit after font size changes
      this.fitAddon.fit();
    }
  }
}
