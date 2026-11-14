const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');
function loadModule(file, dependencies, globals = {}) {
  const module = { exports: {} };
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  vm.runInNewContext(esbuild.transformSync(source, { loader: 'ts', format: 'cjs' }).code, {
    module, exports: module.exports,
    require(id) {
      assert.ok(id in dependencies, `unexpected dependency: ${id}`);
      return dependencies[id];
    },
    ...globals,
  });
  return module.exports;
}

function setupTerminal(command = 'codex --profile xxx', browserTimers = false) {
  const children = [];
  const timers = [];
  const writes = [];
  const settingsModule = loadModule('src/settings/settings.ts', {});
  const settings = structuredClone(settingsModule.DEFAULT_SETTINGS);
  settings.defaultAgent = 'codex';
  settings.agents.codex.command = command;
  settings.welcomeMessage = '';
  settings.autoSendCurrentFile = false;
  const spawn = (...args) => {
    const child = new EventEmitter();
    child.pid = 1000 + children.length;
    child.exitCode = null;
    child.signalCode = null;
    child.signals = [];
    child.args = args;
    child.inputs = [];
    child.kill = signal => { child.signals.push(signal); return true; };
    child.stdin = Object.assign(new EventEmitter(), { end() {}, write(data) { child.inputs.push(data); } });
    child.stdout = Object.assign(new EventEmitter(), { destroy() {} });
    child.stderr = Object.assign(new EventEmitter(), { destroy() {} });
    children.push(child);
    queueMicrotask(() => child.emit('spawn'));
    return child;
  };
  const globals = {
    process: { env: { HOME: '/tmp' }, cwd: () => '/tmp', kill() { throw new Error('no process group was created'); } },
    setTimeout(callback, delay) {
      const timer = { callback, delay, cleared: false, unref() {} };
      timers.push(timer);
      return browserTimers ? timers.length : timer;
    },
    clearTimeout(timer) {
      (typeof timer === 'number' ? timers[timer - 1] : timer).cleared = true;
    }, clearInterval() {},
  };
  const processes = loadModule('src/terminal/process.ts', {
    child_process: { spawn }, '../../scripts/pty_bridge.py?raw': { default: '' },
  }, globals);
  const { TerminalView } = loadModule('src/terminal/TerminalView.ts', {
    obsidian: { ItemView: class {
      constructor() { this.app = {
        vault: { adapter: { basePath: '/tmp' } }, workspace: { getActiveFile: () => null },
      }; }
    }, Notice: class {} },
    '@xterm/xterm': {}, '@xterm/addon-fit': {},
    '../settings/settings': settingsModule, './process': processes,
    string_decoder: require('node:string_decoder'),
  }, globals);
  const plugin = { settings };
  const view = new TerminalView({}, plugin);
  view.terminal = {
    write: text => writes.push(text), writeln: text => writes.push(text),
    scrollToBottom() {}, dispose() {}, options: {}, cols: 120, rows: 35,
  };
  view.fitAddon = { fit() {} };
  return { view, children, timers, writes, plugin, settings, processes, spawn, globals };
}

module.exports = { loadModule, setupTerminal };
