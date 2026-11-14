export interface AgentConfig {
  id: AgentType;
  name: string;
  command: string;
  enabled: boolean;
}

export type AgentType = 'claude' | 'gemini' | 'codex' | 'opencode';

export interface AgentCLIPluginSettings {
  defaultAgent: AgentType;
  agents: {
    claude: AgentConfig;
    gemini: AgentConfig;
    codex: AgentConfig;
    opencode: AgentConfig;
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
    opencode: {
      id: 'opencode',
      name: 'OpenCode CLI',
      command: 'opencode',
      enabled: true,
    },
  },
  terminalFontSize: 13,
  terminalFontFamily: '"JetBrains Mono Regular", "Fira Code", "Cascadia Code", "Source Code Pro", Menlo, Monaco, monospace',
  autoSendCurrentFile: true,
  welcomeMessage: 'Welcome to Agent CLI!',
};

export function getEnabledAgents(settings: AgentCLIPluginSettings): AgentType[] {
  return (Object.keys(settings.agents) as AgentType[]).filter(id => settings.agents[id].enabled);
}

export function mergeSettings(saved: Partial<AgentCLIPluginSettings> | null | undefined): AgentCLIPluginSettings {
  const settings = { ...DEFAULT_SETTINGS, ...saved, agents: { ...DEFAULT_SETTINGS.agents } };
  for (const id of Object.keys(DEFAULT_SETTINGS.agents) as AgentType[]) {
    settings.agents[id] = { ...DEFAULT_SETTINGS.agents[id], ...saved?.agents?.[id], id };
  }
  const enabled = getEnabledAgents(settings);
  if (!enabled.includes(settings.defaultAgent)) {
    settings.defaultAgent = enabled[0] || DEFAULT_SETTINGS.defaultAgent;
  }
  return settings;
}

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
  opencode: {
    description: 'OpenCode AI assistant',
    color: '#9b59b6',
  },
};
