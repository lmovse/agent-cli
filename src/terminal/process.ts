import * as cp from 'child_process';
import bridgeScript from '../../scripts/pty_bridge.py?raw';

export function spawnAgentProcess(command: string, cwd: string, cols = 80, rows = 24): cp.ChildProcess {
  const userHome = process.env.HOME || process.env.USERPROFILE;
  const searchPaths = [process.env.PATH, '/usr/local/bin', '/usr/bin', '/bin',
    '/usr/sbin', '/sbin', '/opt/homebrew/bin', '/opt/local/bin'];
  if (userHome) searchPaths.push(`${userHome}/.local/bin`, `${userHome}/.bun/bin`);

  return cp.spawn('/usr/bin/python3', ['-c', bridgeScript, cwd, command, String(cols), String(rows)], {
    env: { ...process.env, PATH: searchPaths.filter(Boolean).join(':'), TERM: 'xterm-256color' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

export function stopAgentProcess(agentProcess: cp.ChildProcess): void {
  agentProcess.stdin?.end();
  agentProcess.stdout?.destroy();
  agentProcess.stderr?.destroy();
  if (!agentProcess.pid || agentProcess.exitCode !== null || agentProcess.signalCode !== null) return;

  agentProcess.kill('SIGTERM');
  const killTimeout = setTimeout(() => {
    if (agentProcess.exitCode === null && agentProcess.signalCode === null) agentProcess.kill('SIGKILL');
  }, 2000);
  killTimeout.unref?.();
  agentProcess.once('exit', () => clearTimeout(killTimeout));
}
