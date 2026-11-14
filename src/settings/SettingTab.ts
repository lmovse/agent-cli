import { App, PluginSettingTab, Setting, Notice } from 'obsidian';
import AgentCLIPlugin from '../main';
import { AgentType, AGENT_INFO, getEnabledAgents } from './settings';
import { AGENT_ICON_PATHS } from './agentIcons';
import type { ChildProcess } from 'child_process';
import { spawnAgentProcess, stopAgentProcess } from '../terminal/process';

export class SettingTab extends PluginSettingTab {
  plugin: AgentCLIPlugin;
  private pendingTests = new Set<() => void>();
  private disposed = false;
  private testing = false;

  constructor(app: App, plugin: AgentCLIPlugin) {
    super(app, plugin);
    this.plugin = plugin;
    plugin.register(() => {
      this.disposed = true;
      this.pendingTests.forEach(cancel => cancel());
    });
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // Title
    containerEl.createEl('h2', { text: 'Agent CLI Settings' });

    // Default Agent Selection
    new Setting(containerEl)
      .setName('Default Agent')
      .setDesc('Choose which AI agent to use by default')
      .addDropdown((dropdown) => {
        const enabled = getEnabledAgents(this.plugin.settings);
        enabled.forEach(key => {
          const agent = this.plugin.settings.agents[key];
          dropdown.addOption(key, `${agent.name} (${AGENT_INFO[key].description})`);
        });
        dropdown.setDisabled(!enabled.length);
        dropdown.setValue(this.plugin.settings.defaultAgent);
        dropdown.onChange(async (value: AgentType) => {
          this.plugin.settings.defaultAgent = value;
          await this.plugin.saveSettings();
        });
      });

    // Separator
    containerEl.createEl('hr');

    // Agent Configurations
    containerEl.createEl('h3', { text: 'Agent Configurations' });

    // Claude settings
    this.createAgentSettings(containerEl, 'claude');

    // Gemini settings
    this.createAgentSettings(containerEl, 'gemini');

    // Codex settings
    this.createAgentSettings(containerEl, 'codex');

    // OpenCode settings
    this.createAgentSettings(containerEl, 'opencode');

    // Separator
    containerEl.createEl('hr');

    // Terminal Settings
    containerEl.createEl('h3', { text: 'Terminal Settings' });

    // Font size
    new Setting(containerEl)
      .setName('Font Size')
      .setDesc('Terminal font size in pixels')
      .addSlider((slider) => {
        slider.setLimits(10, 24, 1);
        slider.setValue(this.plugin.settings.terminalFontSize);
        slider.onChange(async (value) => {
          this.plugin.settings.terminalFontSize = value;
          await this.plugin.saveSettings();
          slider.showTooltip();
        });
        slider.showTooltip();
      });

    // Font family
    new Setting(containerEl)
      .setName('Font Family')
      .setDesc('Terminal font family (e.g., Menlo, Monaco, monospace)')
      .addText((text) => {
        text.setPlaceholder('"JetBrains Mono Regular", "Fira Code", "Cascadia Code", "Source Code Pro", Menlo, Monaco, monospace');
        text.setValue(this.plugin.settings.terminalFontFamily);
        text.onChange(async (value) => {
          this.plugin.settings.terminalFontFamily = value;
          await this.plugin.saveSettings();
        });
      });

    // Auto send current file
    new Setting(containerEl)
      .setName('Auto-send Current File')
      .setDesc('Automatically insert the current file path when opening terminal')
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.autoSendCurrentFile);
        toggle.onChange(async (value) => {
          this.plugin.settings.autoSendCurrentFile = value;
          await this.plugin.saveSettings();
        });
      });

    // Test Connection Button
    new Setting(containerEl)
      .setName('Test Agent Connections')
      .setDesc('Test if your configured agents are accessible')
      .addButton((button) => {
        button.setButtonText('Test Connections');
        button.onClick(async () => {
          new Notice('Testing agent connections...', 2000);
          await this.testAgentConnections();
        });
      });
  }

  private createAgentSettings(containerEl: HTMLElement, agentId: AgentType): void {
    const agent = this.plugin.settings.agents[agentId];
    const agentInfo = AGENT_INFO[agentId];

    // Section header with the agent's SVG logo.
    const header = containerEl.createEl('div', {
      cls: 'agent-setting-header',
    });
    // Use native DOM APIs: createSvg is not available in every Obsidian runtime.
    const svgNamespace = 'http://www.w3.org/2000/svg';
    const icon = header.ownerDocument.createElementNS(svgNamespace, 'svg');
    for (const [name, value] of Object.entries({
      class: `agent-setting-icon agent-setting-icon-${agentId}`,
      viewBox: '0 0 24 24',
      width: '26',
      height: '26',
      fill: 'currentColor',
      'fill-rule': 'evenodd',
      'aria-hidden': 'true',
      focusable: 'false',
    })) {
      icon.setAttribute(name, value);
    }
    const path = header.ownerDocument.createElementNS(svgNamespace, 'path');
    path.setAttribute('d', AGENT_ICON_PATHS[agentId]);
    icon.appendChild(path);
    header.appendChild(icon);

    header.createEl('h4', {
      text: `${agentInfo.description}`,
    });

    // Enable/disable toggle
    new Setting(containerEl)
      .setName(`Enable ${agent.name}`)
      .addToggle((toggle) => {
        toggle.setValue(agent.enabled);
        toggle.onChange(async (value) => {
          this.plugin.settings.agents[agentId].enabled = value;
          await this.plugin.saveSettings();
          this.display(); // Refresh to show/hide options
        });
      });

    if (agent.enabled) {
      // Command setting
      new Setting(containerEl)
        .setName(`${agent.name} Command`)
        .setDesc(`Command to start ${agent.name}`)
        .addText((text) => {
          text.setValue(agent.command);
          text.onChange(async (value) => {
            this.plugin.settings.agents[agentId].command = value;
            await this.plugin.saveSettings();
          });
        });

      // Custom name
      new Setting(containerEl)
        .setName('Display Name')
        .setDesc('Custom display name for this agent')
        .addText((text) => {
          text.setValue(agent.name);
          text.onChange(async (value) => {
            this.plugin.settings.agents[agentId].name = value;
            await this.plugin.saveSettings();
          });
        });
    }
  }

  private async testAgentConnections(): Promise<void> {
    if (this.testing || this.disposed) return;
    this.testing = true;
    try {
      for (const id of getEnabledAgents(this.plugin.settings)) {
        if (this.disposed) break;
        const agent = this.plugin.settings.agents[id];
        const result = await this.testAgent(agent.command, agent.name);
        if (!this.disposed) new Notice(result.message, result.success ? 3000 : 5000);
      }
    } finally {
      this.testing = false;
    }
  }

  private testAgent(command: string, name: string): Promise<{ success: boolean; message: string }> {
    if (this.disposed) return Promise.resolve({ success: false, message: `${name}: Cancelled` });
    return new Promise((resolve) => {
      let settled = false;
      let current: ChildProcess | null = null;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const clearTimer = (): void => {
        if (timer) clearTimeout(timer);
        timer = undefined;
      };
      const finish = (success: boolean, message: string): void => {
        if (settled) return;
        settled = true;
        clearTimer();
        this.pendingTests.delete(cancel);
        if (current) stopAgentProcess(current);
        resolve({ success, message: `${name}: ${message}` });
      };
      const cancel = (): void => finish(false, 'Cancelled');
      this.pendingTests.add(cancel);
      const runAttempt = (flag: '--version' | '--help'): void => {
        try {
          const cwd = process.env.HOME || process.env.USERPROFILE || process.cwd();
          const proc = spawnAgentProcess(`${command} ${flag}`, cwd);
          current = proc;
          // Drain both streams so a verbose CLI cannot block waiting on a pipe.
          for (const stream of [proc.stdout, proc.stderr]) stream?.on('data', () => {});
          proc.stdin?.on('error', () => {
            if (current === proc) finish(false, '✗ Connection closed');
          });
          proc.on('error', () => {
            if (current === proc) finish(false, '✗ Not accessible');
          });
          proc.on('close', (code: number | null) => {
            if (settled || current !== proc) return;
            clearTimer();
            current = null;
            if (code === 0) finish(true, '✓ Connected');
            else if (flag === '--version' && code !== null) runAttempt('--help');
            else finish(false, `✗ Not accessible (exit ${code})`);
          });
          timer = setTimeout(() => finish(false, '✗ Timeout'), flag === '--version' ? 5000 : 3000);
        } catch (error) {
          finish(false, '✗ Not accessible');
        }
      };
      runAttempt('--version');
    });
  }
}
