import { ItemView, WorkspaceLeaf, Notice } from 'obsidian';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import * as cp from 'child_process';
import AgentCLIPlugin from './main';
import { AgentCLIPluginSettings, AgentType, DEFAULT_SETTINGS } from './settings';

export const AGENT_TERMINAL_VIEW = 'agent-terminal-view';

export class TerminalView extends ItemView {
  private terminal: Terminal;
  private fitAddon: FitAddon;
  private agentProcess: cp.ChildProcess | null = null;
  private currentAgent: AgentType;
  private settings: AgentCLIPluginSettings;
  private cleanupCallbacks: (() => void)[] = [];
  private resizeObserver: ResizeObserver | null = null;

  constructor(leaf: WorkspaceLeaf, private plugin: AgentCLIPlugin) {
    super(leaf);
    // Load initial settings from plugin
    this.settings = { ...DEFAULT_SETTINGS, ...plugin.settings };
    this.currentAgent = this.settings.defaultAgent;
  }

  // Method to refresh settings from plugin
  refreshSettings(): void {
    this.settings = { ...DEFAULT_SETTINGS, ...this.plugin.settings };
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
    this.containerEl.empty();
    this.containerEl.classList.add('agent-terminal-container');

    this.createTerminal();
    this.trackActiveFile();
    await this.startAgent();

    // Auto-send current file if enabled
    if (this.settings.autoSendCurrentFile) {
      const activeFile = this.app.workspace.getActiveFile();
      if (activeFile) {
        // Delay slightly to ensure agent is ready
        setTimeout(() => {
          this.sendCurrentFile();
        }, 1000);
      }
    }
  }

  async onClose(): Promise<void> {
    this.cleanupCallbacks.forEach(cb => cb());
    this.stopAgent();
    this.terminal.dispose();
  }

  override onResize(): void {
    // Terminal will resize automatically via ResizeObserver
  }

  private getAgentName(agentId: AgentType): string {
    return this.settings.agents[agentId]?.name || agentId;
  }

  private createTerminal(): void {
    const terminalContainer = this.containerEl.createDiv({ cls: 'terminal-wrapper' });

    // Auto-detect Obsidian theme
    const isDarkTheme = document.body.classList.contains('theme-dark');

    // Use default rows, fit addon will adjust automatically
    this.terminal = new Terminal({
      fontSize: this.settings.terminalFontSize,
      fontFamily: this.settings.terminalFontFamily,
      theme: isDarkTheme
        ? {
            background: '#1e1e1e',
            foreground: '#d4d4d4',
            cursor: '#d4d4d4',
          }
        : {
            background: '#ffffff',
            foreground: '#333333',
            cursor: '#333333',
          },
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

    // Resize observer to adjust terminal size using fit addon
    this.resizeObserver = new ResizeObserver(() => {
      this.fitAddon.fit();
    });
    this.resizeObserver.observe(terminalContainer);
    this.cleanupCallbacks.push(() => {
      this.resizeObserver?.disconnect();
    });

    // Write welcome message
    this.terminal.writeln('\x1b[1;34m🤖 Agent CLI Terminal\x1b[0m');
    this.terminal.writeln('');

    // Auto-focus the terminal
    this.terminal.focus();
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
    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile) {
      new Notice('No file is currently open', 3000);
      return;
    }

    // Send vault-relative path to terminal
    if (this.agentProcess && this.agentProcess.stdin) {
      this.agentProcess.stdin.write(`@${activeFile.path}\r`);
    }

    new Notice(`Sent @${activeFile.path} to agent`, 3000);
  }

  sendToAgent(text: string): void {
    if (!this.agentProcess) {
      this.terminal.writeln('\x1b[31m⚠️ Agent process not running. Please restart.\x1b[0m');
      return;
    }

    this.terminal.write(text + '\r\n');
    if (this.agentProcess.stdin) {
      this.agentProcess.stdin.write(text + '\r\n');
    }
  }

  private sendToProcess(data: string): void {
    if (this.agentProcess && this.agentProcess.stdin) {
      this.agentProcess.stdin.write(data);
    }
  }

  private async startAgent(): Promise<void> {
    const agentId = this.currentAgent;
    const agentConfig = this.settings.agents[agentId];
    const agentCommand = agentConfig.command;

    try {
      const userHome = process.env.HOME || process.env.USERPROFILE;

      // Get vault base path (full filesystem path)
      const vaultBasePath = (this.app.vault.adapter as any).basePath || this.app.vault.getRoot().path;

      // Use vault root as working directory
      const escapedCwd = vaultBasePath.replace(/"/g, '\\"');

      // Python PTY script - properly load user config and start agent
      const pythonScript = [
        'import os',
        'import pty',
        'import selectors',
        'import sys',
        'import time',
        'os.chdir("' + escapedCwd + '")',
        'pid, pty_fd = pty.fork()',
        'if pid == 0:',
        '    os.environ["PS1"] = "%F{green}%n@%m%f:%F{blue}%~%f$ "',
        '    os.execvp("/bin/zsh", ["/bin/zsh", "-i"])',
        'else:',
        '    time.sleep(0.5)',
        '    os.write(pty_fd, ("' + agentCommand + '\\n").encode())',
        '    sel = selectors.DefaultSelector()',
        '    sel.register(pty_fd, selectors.EVENT_READ)',
        '    sel.register(sys.stdin.fileno(), selectors.EVENT_READ)',
        '    while True:',
        '        for key, _ in sel.select():',
        '            if key.fileobj == pty_fd:',
        '                try:',
        '                    data = os.read(pty_fd, 1024)',
        '                    if not data:',
        '                        break',
        '                    sys.stdout.buffer.write(data)',
        '                    sys.stdout.buffer.flush()',
        '                except OSError:',
        '                    break',
        '            else:',
        '                data = os.read(sys.stdin.fileno(), 1024)',
        '                if not data:',
        '                    break',
        '                os.write(pty_fd, data)',
      ].join('\n');

      const shellArgs = ['-c', pythonScript];

      this.agentProcess = cp.spawn('/usr/bin/python3', shellArgs, {
        env: {
          ...process.env,
          PATH: `/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/opt/local/bin:${userHome}/.local/bin`,
          HOME: userHome,
          TERM: 'xterm-256color',
          PS1: '%F{green}%n@%m%f:%F{blue}%~%f$ ',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      // Filter out zsh compsys warnings
      const filterZshWarning = (data: Buffer): boolean => {
        const text = data.toString();
        // Ignore zsh global variable warnings from compsys
        if (text.includes('RETVAL created globally')) return true;
        return false;
      };

      // Process output to terminal (filter warnings from stdout too)
      this.agentProcess.stdout?.on('data', (data: Buffer) => {
        if (filterZshWarning(data)) return;
        this.terminal.write(data.toString());
        setTimeout(() => {
          this.terminal.scrollToBottom();
        }, 10);
      });

      this.agentProcess.stderr?.on('data', (data: Buffer) => {
        if (filterZshWarning(data)) return;
        this.terminal.write(data.toString());
        setTimeout(() => {
          this.terminal.scrollToBottom();
        }, 10);
      });

      this.agentProcess.on('error', (error: Error) => {
        this.terminal.writeln(`\x1b[31m❌ Failed to start ${agentConfig.name}: ${error.message}\x1b[0m`);
      });

      this.agentProcess.on('exit', (code: number | null) => {
        if (code !== 0 && code !== null) {
          this.terminal.writeln(`\r\n\x1b[33m⚠️ Agent process exited with code ${code}\x1b[0m`);
        }
        this.agentProcess = null;
      });

    } catch (error) {
      this.terminal.writeln(`\x1b[31m❌ Error: ${(error as Error).message}\x1b[0m`);
    }
  }

  private stopAgent(): void {
    if (this.agentProcess) {
      this.agentProcess.kill();
      this.agentProcess = null;
    }
  }

  async restartAgent(): Promise<void> {
    this.stopAgent();
    await this.startAgent();
  }

  async openAgentSelector(): Promise<void> {
    // Cycle through enabled agents
    const enabledAgents = Object.keys(this.settings.agents).filter(
      key => this.settings.agents[key as AgentType].enabled
    ) as AgentType[];

    const currentIndex = enabledAgents.indexOf(this.currentAgent);
    const nextIndex = (currentIndex + 1) % enabledAgents.length;
    this.currentAgent = enabledAgents[nextIndex];

    await this.restartAgent();
  }

  updateSettings(): void {
    this.settings = { ...DEFAULT_SETTINGS, ...this.plugin.settings };
    if (this.terminal && this.fitAddon) {
      this.terminal.options.fontSize = this.settings.terminalFontSize;
      this.terminal.options.fontFamily = this.settings.terminalFontFamily;
      // Re-fit after font size changes
      this.fitAddon.fit();
    }
  }
}
