import json
import os
from pathlib import Path
import shlex
import signal
import subprocess
import sys
import tempfile
import time
import unittest


BRIDGE = Path(__file__).with_name("pty_bridge.py")
FIXTURE = """
import fcntl, json, os, signal, struct, subprocess, sys, termios, time
if 'ignore' in sys.argv[2]:
    signal.signal(signal.SIGHUP, signal.SIG_IGN)
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'],
                         preexec_fn=os.setpgrp if 'separate' in sys.argv[2] else None)
def resized(*args):
    rows, cols, _, _ = struct.unpack('HHHH', fcntl.ioctl(0, termios.TIOCGWINSZ, bytes(8)))
    with open(sys.argv[1] + '.size', 'w') as output:
        json.dump([cols, rows], output)
signal.signal(signal.SIGWINCH, resized)
with open(sys.argv[1], 'w') as output:
    json.dump({'agent': os.getpid(), 'child': child.pid, 'shell': os.getsid(0),
               'group': os.getpgrp(),
               'size': list(struct.unpack('HHHH', fcntl.ioctl(0, termios.TIOCGWINSZ, bytes(8))))[:2]}, output)
print('READY', flush=True)
while True:
    time.sleep(1)
"""


def wait_until(predicate, timeout=5):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.02)
    return False


def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False


class BridgeLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="agent-cli-test-")
        self.root = Path(self.directory.name)
        self.info_path = self.root / "agent.json"
        (self.root / "fixture.py").write_text(FIXTURE)
        # Keep the test independent of the user's interactive shell configuration.
        (self.root / ".zshrc").write_text("PROMPT=''\n")
        self.env = dict(os.environ, ZDOTDIR=str(self.root), TERM="xterm-256color")
        self.log = (self.root / "output.log").open("w+b")
        self.processes = []
        self.info = None
        self.orphan_bridge = None

    def command(self, ignore=False, separate=False):
        return shlex.join([sys.executable, str(self.root / "fixture.py"),
                           str(self.info_path), ("ignore" if ignore else "normal") +
                           ("-separate" if separate else "")])

    def start(self, command=None, cols=80, rows=24):
        proc = subprocess.Popen(
            [sys.executable, str(BRIDGE), str(self.root), command or self.command(), str(cols), str(rows)],
            stdin=subprocess.PIPE, stdout=self.log, stderr=self.log, env=self.env,
        )
        self.processes.append(proc)
        return proc

    def ready(self):
        def load():
            try:
                self.info = json.loads(self.info_path.read_text())
                return True
            except (FileNotFoundError, json.JSONDecodeError):
                return False
        self.assertTrue(wait_until(load), "test agent did not start")

    def assert_children_stopped(self):
        for key in ("agent", "child", "shell"):
            self.assertTrue(wait_until(lambda: not alive(self.info[key])),
                            f"{key} process {self.info[key]} survived shutdown")

    def tearDown(self):
        # Only clean up processes created by this test, including on baseline failure.
        if self.info:
            try:
                os.kill(self.info["child"], signal.SIGKILL)
            except ProcessLookupError:
                pass
            for group in {self.info["group"], self.info["shell"]}:
                if group > 1 and group != os.getpgrp():
                    try:
                        os.killpg(group, signal.SIGKILL)
                    except (ProcessLookupError, PermissionError):
                        pass
        for proc in self.processes:
            if proc.poll() is None:
                proc.kill()
            proc.wait(timeout=5)
            if proc.stdin and not proc.stdin.closed:
                try:
                    proc.stdin.close()
                except BrokenPipeError:
                    pass
        if self.orphan_bridge and alive(self.orphan_bridge):
            os.kill(self.orphan_bridge, signal.SIGKILL)
        self.log.close()
        self.directory.cleanup()

    def test_stdin_eof_stops_bridge_and_children(self):
        proc = self.start()
        self.ready()
        proc.stdin.close()
        self.assertEqual(proc.wait(timeout=4), 0)
        self.assert_children_stopped()

    def test_shell_exit_stops_bridge(self):
        proc = self.start("exit")
        self.assertEqual(proc.wait(timeout=4), 0)

    def test_sigterm_stops_shell_and_stubborn_agent(self):
        proc = self.start(self.command(ignore=True))
        self.ready()
        proc.terminate()
        proc.wait(timeout=4)
        self.assert_children_stopped()

    def test_closed_stdin_before_shell_start(self):
        proc = self.start("sleep 60")
        proc.stdin.close()
        self.assertEqual(proc.wait(timeout=4), 0)

    def test_split_resize_frame_does_not_crash_bridge(self):
        proc = self.start()
        self.ready()
        for chunk in (b"\x00RES", b"IZE:100:", b"35\n"):
            proc.stdin.write(chunk)
            proc.stdin.flush()
            time.sleep(0.05)
        size_path = Path(str(self.info_path) + ".size")
        self.assertTrue(wait_until(size_path.exists), "split resize was not delivered")
        self.assertEqual(json.loads(size_path.read_text()), [100, 35])
        self.assertIsNone(proc.poll())

    def test_host_crash_closes_pipe_and_stops_bridge(self):
        pid_path = self.root / "bridge.pid"
        host = subprocess.Popen([
            sys.executable, "-c",
            "import pathlib, subprocess, sys, time; "
            "p = subprocess.Popen(sys.argv[2:], stdin=subprocess.PIPE); "
            "pathlib.Path(sys.argv[1]).write_text(str(p.pid)); time.sleep(60)",
            str(pid_path), sys.executable, str(BRIDGE), str(self.root), self.command(),
        ], stdout=self.log, stderr=self.log, env=self.env)
        self.processes.append(host)
        self.ready()
        self.orphan_bridge = int(pid_path.read_text())
        host.kill()
        host.wait(timeout=4)
        self.assertTrue(wait_until(lambda: not alive(self.orphan_bridge)),
                        "bridge survived its host process")
        self.assert_children_stopped()

    def test_closed_output_pipe_stops_bridge_and_children(self):
        proc = subprocess.Popen(
            [sys.executable, str(BRIDGE), str(self.root), self.command()],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.log, env=self.env,
        )
        self.processes.append(proc)
        self.ready()
        proc.stdout.close()
        proc.stdin.write(b"trigger terminal echo\n")
        proc.stdin.flush()
        self.assertEqual(proc.wait(timeout=4), 0)
        self.assert_children_stopped()

    def test_protocol_error_still_cleans_up_children(self):
        proc = self.start()
        self.ready()
        proc.stdin.write(b"\x00RESIZE:invalid:24\n")
        proc.stdin.flush()
        self.assertNotEqual(proc.wait(timeout=4), 0)
        self.assert_children_stopped()

    def test_repeated_open_and_close_does_not_leave_processes(self):
        for index in range(3):
            with self.subTest(index=index):
                self.info_path = self.root / f"agent-{index}.json"
                proc = self.start()
                self.ready()
                proc.stdin.close()
                self.assertEqual(proc.wait(timeout=4), 0)
                self.assert_children_stopped()

    def test_stubborn_child_in_another_group_is_stopped(self):
        proc = self.start(self.command(ignore=True, separate=True))
        self.ready()
        self.assertEqual(os.getsid(self.info["child"]), self.info["shell"])
        self.assertNotEqual(os.getpgid(self.info["child"]), self.info["group"])
        proc.stdin.close()
        self.assertEqual(proc.wait(timeout=4), 0)
        self.assert_children_stopped()

    def test_agent_exit_cannot_turn_input_into_shell_commands(self):
        proc = self.start("true; printf done > agent-finished")
        self.assertTrue(wait_until((self.root / "agent-finished").exists))
        try:
            proc.stdin.write(b"printf unsafe > note-executed\r\n")
            proc.stdin.flush()
        except BrokenPipeError:
            pass
        self.assertEqual(proc.wait(timeout=4), 0)
        self.assertFalse((self.root / "note-executed").exists())

    def test_agent_receives_initial_terminal_size(self):
        proc = self.start(cols=120, rows=35)
        self.ready()
        self.assertEqual(self.info["size"], [35, 120])

    def test_failed_command_returns_failure(self):
        proc = self.start("agent-cli-nonexistent-test-command")
        self.assertNotEqual(proc.wait(timeout=4), 0)

    def test_quoted_profile_arguments_are_preserved(self):
        script = self.root / "agent with spaces.py"
        script.write_text(
            "import json, pathlib, sys; "
            "pathlib.Path('arguments.json').write_text(json.dumps(sys.argv[1:]))"
        )
        proc = self.start(shlex.join([sys.executable, str(script), "--profile", "work profile"]))
        self.assertEqual(proc.wait(timeout=4), 0)
        self.assertEqual(json.loads((self.root / "arguments.json").read_text()),
                         ["--profile", "work profile"])


if __name__ == "__main__":
    unittest.main()
