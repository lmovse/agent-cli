const assert = require('node:assert/strict');
const { test } = require('node:test');
const { loadModule, setupTerminal } = require('./test_helpers.cjs');

test('a late exit from the old bridge cannot clear the restarted bridge', async () => {
  const { view, children, writes } = setupTerminal();
  await view.startAgent();
  await view.restartAgent();
  children[0].emit('exit', 1);
  children[0].emit('error', new Error('late error'));
  children[0].stdout.emit('data', Buffer.from('codex --profile xxx\nold output'));
  assert.equal(view.agentProcess, children[1]);
  assert.equal(writes.length, 0, 'retired bridge callbacks must not change the terminal');
  view.stopAgent();
  assert.equal(children[1].signals[0], 'SIGTERM');
});

test('shutdown signals the bridge gracefully with a bounded kill fallback', async () => {
  const { view, children, timers } = setupTerminal();
  await view.startAgent();
  view.stopAgent();
  assert.equal(view.agentProcess, null);
  assert.deepEqual(children[0].signals, ['SIGTERM']);
  const timeout = timers.find(timer => timer.delay >= 1000);
  assert.ok(timeout, 'a bridge that cannot exit must not live forever');
  timeout.callback();
  assert.deepEqual(children[0].signals, ['SIGTERM', 'SIGKILL']);
});

test('normal bridge exit cancels the kill fallback', async () => {
  const { view, children, timers } = setupTerminal();
  await view.startAgent();
  view.stopAgent();
  children[0].emit('exit', 0);
  assert.ok(timers.find(timer => timer.delay >= 1000)?.cleared);
});

test('shutdown also accepts browser timer handles in the Obsidian renderer', async () => {
  const { view, children } = setupTerminal('codex', true);
  await view.startAgent();
  view.stopAgent();
  assert.equal(children[0].signals[0], 'SIGTERM');
  children[0].emit('exit', 0);
});

test('stdin pipe errors stop the bridge without an unhandled error', async () => {
  const { view, children } = setupTerminal();
  await view.startAgent();
  children[0].stdin.emit('error', new Error('write EPIPE'));
  assert.equal(view.agentProcess, null);
  assert.equal(children[0].signals[0], 'SIGTERM');
});

test('close stops the bridge before observer cleanup and ignores delayed output', async () => {
  const { view, children, timers } = setupTerminal();
  await view.startAgent();
  children[0].stdout.emit('data', Buffer.from('codex --profile xxx\nready'));
  view.terminal.scrollToBottom = () => { throw new Error('terminal is disposed'); };
  view.cleanupCallbacks.push(() => { assert.equal(view.agentProcess, null); });
  await view.onClose();
  for (const timer of timers.filter(timer => timer.delay === 10)) timer.callback();
});

test('command arguments still connect across split ANSI output', async () => {
  const { view, children, writes } = setupTerminal();
  view.loadingInterval = 42;
  await view.startAgent();
  for (const chunk of ['\x1b[3', '2mcodex\x1b[39m --pro', 'file xxx\r\nREADY']) {
    children[0].stdout.emit('data', Buffer.from(chunk));
  }
  assert.equal(view.loadingInterval, null);
  assert.ok(writes.some(text => text.includes('READY')));
});

test('UTF-8 text survives a split at every byte', async () => {
  const { view, children, writes } = setupTerminal();
  await view.startAgent();
  children[0].stdout.emit('data', Buffer.from('codex --profile xxx\n'));
  for (const byte of Buffer.from('你好 👋')) children[0].stdout.emit('data', Buffer.from([byte]));
  assert.ok(writes.join('').includes('你好 👋'));
  assert.ok(!writes.join('').includes('\uFFFD'));
});

test('OSC titles and warnings cannot keep the terminal connecting', async () => {
  const { view, children, writes } = setupTerminal();
  view.loadingInterval = 42;
  await view.startAgent();
  const output = '\x1b]0;terminal\x1b\\RETVAL created globally\ncodex --profile xxx\x1b]0;agent\x1b\\READY';
  children[0].stdout.emit('data', Buffer.from(output));
  assert.equal(view.loadingInterval, null);
  assert.ok(writes.join('').includes('READY'));
});

test('natural exit drains final stdout and stderr until close', async () => {
  const { view, children, writes } = setupTerminal();
  await view.startAgent();
  children[0].stdout.emit('data', Buffer.from('codex --profile xxx\n'));
  children[0].emit('exit', 1);
  const before = children[0].inputs.length;
  await view.sendToAgent('do not send after exit');
  assert.equal(children[0].inputs.length, before);
  children[0].stdout.emit('data', Buffer.from('last result'));
  children[0].stderr.emit('data', Buffer.from('last error details'));
  children[0].emit('close', 1);
  assert.ok(writes.join('').includes('last result'));
  assert.ok(writes.join('').includes('last error details'));
});

test('disabled defaults fall back and no enabled agent starts no process', async () => {
  const { view, children, settings } = setupTerminal();
  settings.agents.codex.enabled = false;
  await view.startAgent();
  assert.equal(view.currentAgent, 'claude');
  view.stopAgent();
  for (const agent of Object.values(settings.agents)) agent.enabled = false;
  const count = children.length;
  await view.startAgent();
  await view.openAgentSelector();
  assert.equal(children.length, count);
});

test('startup applies geometry, welcome and auto-file once, with an opt-out', async () => {
  const { view, children, writes, settings } = setupTerminal();
  settings.autoSendCurrentFile = true;
  settings.welcomeMessage = 'Hello';
  view.app.workspace.getActiveFile = () => ({ path: 'notes/example.md' });
  await view.startAgent();
  assert.ok(children[0].args.flat().includes('120'));
  assert.ok(children[0].args.flat().includes('35'));
  assert.ok(writes.includes('Hello'));
  assert.equal(children[0].inputs.filter(text => text === '@notes/example.md ').length, 1);
  settings.autoSendCurrentFile = false;
  await view.restartAgent();
  assert.ok(!children[1].inputs.some(text => text.includes('@notes/example.md')));
});

test('closing a view cancels a queued send before it can touch the disposed terminal', async () => {
  const { view, children } = setupTerminal();
  await view.startAgent();
  let disposed = false;
  view.terminal.dispose = () => { disposed = true; };
  view.terminal.writeln = () => { assert.equal(disposed, false); };
  const before = children[0].inputs.length;
  const pending = view.sendToAgent('queued text');
  await Promise.all([view.onClose(), pending]);
  assert.equal(children[0].inputs.length, before);
});

test('plugin shutdown and app quit stop terminal processes explicitly', async () => {
  const actions = [];
  let quit;
  const { default: Plugin } = loadModule('src/main.ts', {
    obsidian: { Plugin: class {}, MarkdownView: class {} },
    './settings/settings': {},
    './settings/SettingTab': { SettingTab: class {} },
    './terminal/TerminalView': { AGENT_TERMINAL_VIEW: 'agent-terminal-view' },
  });
  const plugin = new Plugin();
  plugin.app = { workspace: {
    on(name, callback) { if (name === 'quit') quit = callback; return {}; },
    getLeavesOfType() { return [{ view: { stopAgent() { actions.push('stop'); } } }]; },
    detachLeavesOfType() { actions.push('detach'); },
  } };
  plugin.loadSettings = async () => {};
  for (const method of ['registerView', 'registerEvent', 'addRibbonIcon', 'addCommand', 'addSettingTab']) {
    plugin[method] = () => {};
  }
  await plugin.onload();
  assert.equal(typeof quit, 'function');
  quit();
  plugin.onunload();
  assert.deepEqual(actions, ['stop', 'stop', 'detach']);
});
