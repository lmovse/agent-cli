import os
import pty
import selectors
import signal
import sys
import time
import struct
import fcntl
import termios
import errno
import subprocess


def signal_groups(groups, signum):
    alive = False
    for group in groups:
        try:
            os.killpg(group, signum)
            alive = True
        except (ProcessLookupError, PermissionError):
            # macOS can return EPERM for a group whose only member is a zombie.
            pass
    return alive


def session_groups(session_id):
    # Read only IDs, never command lines or environment variables. getsid works
    # on both macOS and Linux (ps formats session identifiers differently).
    try:
        listing = subprocess.check_output(
            ["/bin/ps", "-axo", "pid=,pgid="], text=True, timeout=1,
        )
    except (OSError, subprocess.SubprocessError):
        print("Warning: unable to inspect terminal session processes", file=sys.stderr)
        return set()
    groups = set()
    for line in listing.splitlines():
        process_id, group = map(int, line.split())
        try:
            if os.getsid(process_id) == session_id:
                groups.add(group)
        except (ProcessLookupError, PermissionError):
            pass
    return groups


def cleanup_child(pid, pty_fd):
    child, status = os.waitpid(pid, os.WNOHANG)
    reaped = child == pid
    groups = {pid} | session_groups(pid)
    try:
        groups.add(os.tcgetpgrp(pty_fd))
    except OSError:
        pass
    groups = {group for group in groups if group > 1 and group != os.getpgrp()}
    signal_groups(groups, signal.SIGHUP)
    signal_groups(groups, signal.SIGTERM)
    os.close(pty_fd)

    deadline = time.monotonic() + 0.5
    while time.monotonic() < deadline:
        if not reaped:
            child, status = os.waitpid(pid, os.WNOHANG)
            reaped = child == pid
        new_groups = session_groups(pid) - groups
        signal_groups(new_groups, signal.SIGTERM)
        groups.update(new_groups)
        if not signal_groups(groups, 0):
            break
        time.sleep(0.02)

    # A CLI or its subprocesses may ignore HUP/TERM. Bound their lifetime.
    signal_groups(groups, signal.SIGKILL)
    if not reaped:
        _, status = os.waitpid(pid, 0)
    exit_code = os.waitstatus_to_exitcode(status)
    return exit_code if exit_code >= 0 else 128 - exit_code


def main():
    cwd, agent_command = sys.argv[1:3]
    cols, rows = map(int, sys.argv[3:5]) if len(sys.argv) >= 5 else (80, 24)
    running = True
    stopped_by_host = False

    def stop(signum, frame):
        nonlocal running, stopped_by_host
        running = False
        stopped_by_host = True

    shutdown_signals = (signal.SIGTERM, signal.SIGINT, signal.SIGHUP)
    for signum in shutdown_signals:
        signal.signal(signum, stop)

    os.chdir(cwd)
    if not running:
        return
    pid, pty_fd = pty.fork()
    if pid == 0:
        for signum in shutdown_signals:
            signal.signal(signum, signal.SIG_DFL)
        fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        # One command per session: stdin is never evaluated by a fallback shell.
        os.execvp("/bin/zsh", ["/bin/zsh", "-i", "-c", agent_command])

    sel = selectors.DefaultSelector()
    try:
        sel.register(pty_fd, selectors.EVENT_READ)
        sel.register(sys.stdin.fileno(), selectors.EVENT_READ)
        if not running:
            return
        buf = b""
        resize_prefix = b"\x00RESIZE:"
        while running:
            for key, _ in sel.select(timeout=0.2):
                if key.fileobj == pty_fd:
                    data = os.read(pty_fd, 1024)
                    if not data:
                        running = False
                        break
                    sys.stdout.buffer.write(data)
                    sys.stdout.buffer.flush()
                else:
                    data = os.read(sys.stdin.fileno(), 1024)
                    if not data:
                        # EOF also covers an abrupt Obsidian exit: its pipe closes.
                        running = False
                        stopped_by_host = True
                        break
                    buf += data
                    while buf:
                        if buf.startswith(resize_prefix):
                            end = buf.find(b"\n")
                            if end < 0:
                                break
                            cols, rows = map(int, buf[len(resize_prefix):end].split(b":"))
                            fcntl.ioctl(pty_fd, termios.TIOCSWINSZ,
                                        struct.pack("HHHH", rows, cols, 0, 0))
                            buf = buf[end + 1:]
                        elif resize_prefix.startswith(buf):
                            break
                        else:
                            idx = buf.find(b"\x00", 1)
                            end = idx if idx >= 0 else len(buf)
                            os.write(pty_fd, buf[:end])
                            buf = buf[end:]
    except BrokenPipeError:
        stopped_by_host = True
        # Avoid another failed stdout flush during interpreter shutdown.
        null_fd = os.open(os.devnull, os.O_WRONLY)
        os.dup2(null_fd, sys.stdout.fileno())
        os.close(null_fd)
    except OSError as error:
        if error.errno != errno.EIO:
            raise
    finally:
        sel.close()
        exit_code = cleanup_child(pid, pty_fd)
    return 0 if stopped_by_host else exit_code


if __name__ == "__main__":
    sys.exit(main())
