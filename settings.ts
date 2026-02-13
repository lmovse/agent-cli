export interface AgentConfig {
  id: AgentType;
  name: string;
  command: string;
  enabled: boolean;
}

export type AgentType = 'claude' | 'gemini' | 'codex';

export interface AgentCLIPluginSettings {
  defaultAgent: AgentType;
  agents: {
    claude: AgentConfig;
    gemini: AgentConfig;
    codex: AgentConfig;
  };
  terminalFontSize: number;
  terminalFontFamily: string;
  autoSendCurrentFile: boolean;
  welcomeMessage: string;
}

export const DEFAULT_SETTINGS: AgentCLIPluginSettings = {
  defaultAgent: 'claude',
  agents: {
    claude: {
      id: 'claude',
      name: 'Claude CLI',
      command: 'claude',
      enabled: true,
    },
    gemini: {
      id: 'gemini',
      name: 'Gemini CLI',
      command: 'gemini',
      enabled: true,
    },
    codex: {
      id: 'codex',
      name: 'Codex CLI',
      command: 'codex',
      enabled: true,
    },
  },
  terminalFontSize: 13,
  terminalFontFamily: '"JetBrains Mono Regular", "Fira Code", "Cascadia Code", "Source Code Pro", Menlo, Monaco, monospace',
  autoSendCurrentFile: true,
  welcomeMessage: 'Welcome to Agent CLI! Current file context loaded.',
};

export const AGENT_INFO: Record<AgentType, { description: string; color: string }> = {
  claude: {
    description: 'Anthropic\'s Claude AI assistant',
    color: '#d4a373',
  },
  gemini: {
    description: 'Google\'s Gemini AI model',
    color: '#4a90d9',
  },
  codex: {
    description: 'OpenAI\'s Codex model',
    color: '#5ac54f',
  },
};
