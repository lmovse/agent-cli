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
    this.settings = { ...DEFAULT_SETTINGS, ...plugin.settings };
    this.currentAgent = this.settings.defaultAgent;
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

    this.createHeader();
    this.createTerminal();
    this.trackActiveFile();
    await this.initializeContext();
    await this.startAgent();
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

  private createHeader(): void {
    const header = this.containerEl.createDiv({ cls: 'agent-terminal-header' });

    // Agent selector
    const selector = header.createEl('select', { cls: 'agent-selector' });

    Object.entries(this.settings.agents).forEach(([key, agent]) => {
      if (agent.enabled) {
        const option = selector.createEl('option', {
          value: key,
          text: agent.name,
        });
        if (key === this.currentAgent) {
          option.selected = true;
        }
      }
    });

    selector.addEventListener('change', async (e: Event) => {
      const target = e.target as HTMLSelectElement;
      const newAgent = target.value as AgentType;
      if (newAgent !== this.currentAgent) {
        this.currentAgent = newAgent;
        await this.restartAgent();
      }
    });

    // Refresh button
    const refreshBtn = header.createEl('button', {
      cls: 'agent-refresh-btn',
      text: '↻ Restart',
    });

    refreshBtn.addEventListener('click', async () => {
      await this.restartAgent();
    });

    // Send current file button
    const sendFileBtn = header.createEl('button', {
      cls: 'agent-send-file-btn',
      text: '📄 Send Current File',
    });

    sendFileBtn.addEventListener('click', async () => {
      await this.sendCurrentFile();
    });
  }

  private createTerminal(): void {
    const terminalContainer = this.containerEl.createDiv({ cls: 'terminal-wrapper' });

    // Use default rows, fit addon will adjust automatically
    this.terminal = new Terminal({
      fontSize: this.settings.terminalFontSize,
      fontFamily: this.settings.terminalFontFamily,
      theme: this.settings.terminalTheme === 'dark'
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
    this.terminal.writeln('\x1b[2mPress Enter to start interacting with your agent.\x1b[0m');
    this.terminal.writeln('');

    // Auto-focus the terminal
    this.terminal.focus();
  }

  private trackActiveFile(): void {
    const callback = () => {
      // File tracking handled in initializeContext
    };
    const eventRef = this.app.workspace.on('active-leaf-change', callback);
    this.cleanupCallbacks.push(() => {
      this.app.workspace.off(eventRef, callback);
    });
  }

  private async initializeContext(): Promise<void> {
    const activeFile = this.app.workspace.getActiveFile();
    if (activeFile) {
      this.terminal.writeln(`\x1b[32m📁 Current file: ${activeFile.path}\x1b[0m`);
      this.terminal.writeln('');
    } else {
      this.terminal.writeln(`\x1b[33m⚠️ No file open. Open a file to use its content as context.\x1b[0m`);
      this.terminal.writeln('');
    }
  }

  async sendCurrentFile(): Promise<void> {
    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile) {
      new Notice('No file is currently open', 3000);
      return;
    }

    const fileContent = await this.app.vault.read(activeFile);
    const agentName = this.getAgentName(this.currentAgent);

    this.terminal.writeln(`\x1b[1m--- Sending file context to ${agentName} ---\x1b[0m`);
    this.terminal.writeln(`\x1b[2mFile: ${activeFile.path}\x1b[0m`);

    // Send file content to process
    if (this.agentProcess && this.agentProcess.stdin) {
      this.agentProcess.stdin.write(`/context ${activeFile.path}\n${fileContent}\n/end_context\r\n`);
    }

    new Notice(`Sent ${activeFile.path} to ${agentName}`, 3000);
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

    this.terminal.writeln(`\x1b[1;32m🚀 Starting ${agentConfig.name}...\x1b[0m`);
    this.terminal.writeln(`\x1b[2m[PTY MODE] Using Python PTY\x1b[0m`);
    this.terminal.writeln('');

    try {
      const userHome = process.env.HOME || process.env.USERPROFILE;
      const activeFile = this.app.workspace.getActiveFile();

      // Get vault base path (full filesystem path)
      const vaultBasePath = (this.app.vault.adapter as any).basePath || this.app.vault.getRoot().path;

      // Get current file's directory, or vault root if no file
      const fullCwd = activeFile
        ? `${vaultBasePath}/${activeFile.parent?.path || activeFile.path}`
        : vaultBasePath;

      // Escape the path for Python
      const escapedCwd = fullCwd.replace(/"/g, '\\"');

      // Python PTY script - properly load user config
      const pythonScript = [
        'import os',
        'import pty',
        'import selectors',
        'import sys',
        'os.chdir("' + escapedCwd + '")',
        'pid, pty_fd = pty.fork()',
        'if pid == 0:',
        '    os.environ["PS1"] = "%F{green}%n@%m%f:%F{blue}%~%f$ "',
        '    os.execvp("/bin/zsh", ["/bin/zsh", "-i"])',
        'else:',
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

  private async restartAgent(): Promise<void> {
    this.stopAgent();
    await this.startAgent();
  }

  updateSettings(settings: AgentCLIPluginSettings): void {
    this.settings = settings;
    if (this.terminal && this.fitAddon) {
      this.terminal.options.fontSize = settings.terminalFontSize;
      this.terminal.options.fontFamily = settings.terminalFontFamily;
      // Re-fit after font size changes
      this.fitAddon.fit();
    }
  }
}
