import { App, PluginSettingTab, Setting, Notice } from 'obsidian';
import AgentCLIPlugin from './main';
import { AgentCLIPluginSettings, AgentType, AGENT_INFO, DEFAULT_SETTINGS } from './settings';

export class SettingTab extends PluginSettingTab {
  plugin: AgentCLIPlugin;

  constructor(app: App, plugin: AgentCLIPlugin) {
    super(app, plugin);
    this.plugin = plugin;
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
        Object.entries(this.plugin.settings.agents).forEach(([key, agent]) => {
          if (agent.enabled) {
            dropdown.addOption(key, `${agent.name} (${AGENT_INFO[key as AgentType].description})`);
          }
        });
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
      .setDesc('Automatically send current file content when opening terminal')
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

    // Section header with color
    const header = containerEl.createEl('div', {
      cls: 'agent-setting-header',
    });
    header.style.borderLeft = `3px solid ${agentInfo.color}`;
    header.style.paddingLeft = '10px';
    header.style.marginTop = '15px';

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
    for (const [agentId, agent] of Object.entries(this.plugin.settings.agents)) {
      if (agent.enabled) {
        try {
          // Test connection with timeout
          const result = await this.testAgent(agent.command, agent.name);
          new Notice(result.message, result.success ? 3000 : 5000);
        } catch (error) {
          new Notice(`${agentId}: Error testing`, 3000);
        }
      }
    }
  }

  private testAgent(command: string, name: string): Promise<{ success: boolean; message: string }> {
    return new Promise((resolve) => {
      const { spawn } = require('child_process');

      // Get user's PATH to find the command
      const userHome = process.env.HOME || process.env.USERPROFILE;
      const extendedPath = `/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/opt/local/bin:${userHome}/.local/bin:${userHome}/.bun/bin:${userHome}/.nvm/versions/node/*/bin:/usr/local/go/bin`;

      // Try to run command with --version or --help
      const proc = spawn(command, ['--version'], {
        stdio: 'pipe',
        shell: true,
        env: {
          ...process.env,
          PATH: extendedPath,
          HOME: userHome,
        },
      });

      let output = '';
      let resolved = false;

      const cleanup = () => {
        if (!resolved) {
          resolved = true;
          try {
            proc.kill();
          } catch (e) {
            // Ignore kill errors
          }
        }
      };

      // Timeout after 5 seconds
      const timeout = setTimeout(() => {
        cleanup();
        resolve({ success: false, message: `${name}: ✗ Timeout` });
      }, 5000);

      proc.stdout?.on('data', (data: Buffer) => {
        output += data.toString();
      });

      proc.stderr?.on('data', (data: Buffer) => {
        output += data.toString();
      });

      proc.on('close', (code: number) => {
        clearTimeout(timeout);
        cleanup();
        if (code === 0) {
          resolve({ success: true, message: `${name}: ✓ Connected` });
        } else if (code !== null) {
          // Try with --help if --version fails
          const helpProc = spawn(command, ['--help'], {
            stdio: 'pipe',
            shell: true,
            env: {
              ...process.env,
              PATH: extendedPath,
              HOME: userHome,
            },
          });

          let helpOutput = '';
          const helpTimeout = setTimeout(() => {
            try { helpProc.kill(); } catch (e) {}
            resolve({ success: false, message: `${name}: ✗ Not accessible (exit ${code})` });
          }, 3000);

          helpProc.stdout?.on('data', (data: Buffer) => {
            helpOutput += data.toString();
          });

          helpProc.on('close', (helpCode: number) => {
            clearTimeout(helpTimeout);
            if (helpCode === 0 || helpOutput.includes('usage') || helpOutput.includes('help')) {
              resolve({ success: true, message: `${name}: ✓ Connected` });
            } else {
              resolve({ success: false, message: `${name}: ✗ Not accessible (exit ${helpCode})` });
            }
          });

          helpProc.on('error', () => {
            clearTimeout(helpTimeout);
            resolve({ success: false, message: `${name}: ✗ Not accessible (exit ${code})` });
          });
        } else {
          resolve({ success: false, message: `${name}: ✗ Not found` });
        }
      });

      proc.on('error', () => {
        clearTimeout(timeout);
        cleanup();
        resolve({ success: false, message: `${name}: ✗ Not found` });
      });
    });
  }
}
