const assert = require('node:assert/strict');
const { test } = require('node:test');
const { loadModule, setupTerminal } = require('./test_helpers.cjs');

function createPlugin() {
  const settingsModule = loadModule('src/settings/settings.ts', {});
  const { default: Plugin } = loadModule('src/main.ts', {
    obsidian: { Plugin: class {} }, './settings/settings': settingsModule,
    './terminal/TerminalView': { AGENT_TERMINAL_VIEW: 'agent-terminal-view' },
    './settings/SettingTab': {},
  });
  return { plugin: new Plugin(), settingsModule };
}

test('partial saved agents inherit defaults without sharing mutable defaults', async () => {
  const { plugin, settingsModule } = createPlugin();
  plugin.loadData = async () => ({ defaultAgent: 'codex', agents: { codex: { command: 'codex --profile work' } } });
  await plugin.loadSettings();
  assert.equal(plugin.settings.agents.claude.command, 'claude');
  assert.equal(plugin.settings.agents.codex.enabled, true);
  assert.equal(plugin.settings.agents.codex.command, 'codex --profile work');
  plugin.settings.agents.claude.command = 'changed';
  assert.equal(settingsModule.DEFAULT_SETTINGS.agents.claude.command, 'claude');
});

test('disabled default is normalized to an enabled agent', async () => {
  const { plugin } = createPlugin();
  plugin.loadData = async () => ({ defaultAgent: 'codex', agents: { codex: { enabled: false } } });
  await plugin.loadSettings();
  assert.equal(plugin.settings.defaultAgent, 'claude');
});

test('saving terminal settings updates open terminal views', async () => {
  const { plugin } = createPlugin();
  plugin.loadData = async () => null;
  await plugin.loadSettings();
  let updates = 0;
  plugin.app = { workspace: { getLeavesOfType: () => [{ view: { updateSettings() { updates++; } } }] } };
  plugin.saveData = async () => {};
  plugin.settings.terminalFontSize = 20;
  await plugin.saveSettings();
  assert.equal(updates, 1);
});

test('settings render every agent and terminal options without Obsidian createSvg extensions', () => {
  const elements = [];
  const document = {
    createElementNS(namespace, tag) {
      return new Element(tag, namespace);
    },
  };
  class Element {
    constructor(tag, namespace = 'http://www.w3.org/1999/xhtml') {
      this.tag = tag;
      this.namespaceURI = namespace;
      this.ownerDocument = document;
      this.children = [];
      this.attributes = {};
      elements.push(this);
    }
    empty() { this.children = []; }
    appendChild(child) { this.children.push(child); return child; }
    setAttribute(name, value) { this.attributes[name] = value; }
    createEl(tag, options = {}) {
      const child = new Element(tag);
      child.text = options.text;
      return this.appendChild(child);
    }
  }
  const settingNames = [];
  const control = {};
  for (const method of ['addOption', 'setDisabled', 'setValue', 'onChange', 'setLimits',
    'showTooltip', 'setPlaceholder', 'setButtonText', 'onClick']) {
    control[method] = () => control;
  }
  class Setting {
    setName(name) { settingNames.push(name); return this; }
    setDesc() { return this; }
  }
  for (const method of ['addDropdown', 'addSlider', 'addText', 'addToggle', 'addButton']) {
    Setting.prototype[method] = function(callback) { callback(control); return this; };
  }
  const settingsModule = loadModule('src/settings/settings.ts', {});
  const { AGENT_ICON_PATHS } = loadModule('src/settings/agentIcons.ts', {});
  const { SettingTab } = loadModule('src/settings/SettingTab.ts', {
    obsidian: { PluginSettingTab: class {}, Setting },
    './settings': settingsModule, './agentIcons': { AGENT_ICON_PATHS },
    '../terminal/process': {},
  });
  const tab = new SettingTab({}, {
    register() {}, settings: structuredClone(settingsModule.DEFAULT_SETTINGS),
  });
  tab.containerEl = new Element('div');
  tab.display();
  const icons = elements.filter(element => element.tag === 'svg');
  assert.equal(icons.length, 4);
  for (const [index, id] of Object.keys(AGENT_ICON_PATHS).entries()) {
    const icon = icons[index];
    assert.equal(icon.namespaceURI, 'http://www.w3.org/2000/svg');
    assert.equal(icon.attributes.viewBox, '0 0 24 24');
    assert.ok(icon.attributes.class.includes(`agent-setting-icon-${id}`));
    assert.equal(icon.children[0].namespaceURI, icon.namespaceURI);
    assert.equal(icon.children[0].attributes.d, AGENT_ICON_PATHS[id]);
    assert.ok(settingNames.includes(`Enable ${settingsModule.DEFAULT_SETTINGS.agents[id].name}`));
  }
  assert.ok(settingNames.includes('Font Size'));
  assert.ok(settingNames.includes('Test Agent Connections'));
});

function setupConnectionTest() {
  const terminal = setupTerminal();
  const cleanup = [];
  const dependencies = {
    obsidian: { PluginSettingTab: class {}, Notice: class {} },
    './settings': loadModule('src/settings/settings.ts', {}),
    './agentIcons': loadModule('src/settings/agentIcons.ts', {}),
    '../terminal/process': terminal.processes,
    child_process: { spawn: terminal.spawn },
  };
  const { SettingTab } = loadModule('src/settings/SettingTab.ts', dependencies, terminal.globals);
  const tab = new SettingTab({}, { register: callback => cleanup.push(callback) });
  return { ...terminal, tab, cleanup };
}

test('connection timeout cannot launch a late help fallback', async () => {
  const { tab, timers, children } = setupConnectionTest();
  const result = tab.testAgent('codex --profile work', 'Codex');
  timers.find(timer => timer.delay === 5000).callback();
  assert.equal((await result).success, false);
  children[0].emit('close', 1);
  assert.equal(children.length, 1);
  assert.equal(children[0].signals[0], 'SIGTERM');
});

test('connection checks use the same supervised command runner', async () => {
  const { tab, children } = setupConnectionTest();
  const result = tab.testAgent('codex --profile work', 'Codex');
  assert.equal(children[0].args[0], '/usr/bin/python3');
  assert.ok(children[0].args[1].includes('codex --profile work --version'));
  children[0].emit('close', 1);
  assert.ok(children[1].args[1].includes('codex --profile work --help'));
  children[1].emit('close', 0);
  assert.equal((await result).success, true);
});

test('plugin unload cancels pending connection checks', async () => {
  const { tab, children, cleanup } = setupConnectionTest();
  const result = tab.testAgent('fake-agent', 'Fake');
  assert.equal(cleanup.length, 1);
  cleanup[0]();
  assert.equal((await result).success, false);
  assert.equal(children[0].signals[0], 'SIGTERM');
  children[0].emit('close', 1);
  assert.equal(children.length, 1);
});
