import os
import pty
import selectors
import sys
import time
import struct
import fcntl
import termios

cwd = sys.argv[1]
agent_command = sys.argv[2]

os.chdir(cwd)
pid, pty_fd = pty.fork()

if pid == 0:
    os.environ["PS1"] = "%F{green}%n@%m%f:%F{blue}%~%f$ "
    os.execvp("/bin/zsh", ["/bin/zsh", "-i"])
else:
    time.sleep(0.5)
    os.write(pty_fd, (agent_command + "\n").encode())
    sel = selectors.DefaultSelector()
    sel.register(pty_fd, selectors.EVENT_READ)
    sel.register(sys.stdin.fileno(), selectors.EVENT_READ)
    buf = b""
    while True:
        for key, _ in sel.select():
            if key.fileobj == pty_fd:
                try:
                    data = os.read(pty_fd, 1024)
                    if not data:
                        break
                    sys.stdout.buffer.write(data)
                    sys.stdout.buffer.flush()
                except OSError:
                    break
            else:
                data = os.read(sys.stdin.fileno(), 1024)
                if not data:
                    break
                buf += data
                while b"\x00RESIZE:" in buf:
                    idx = buf.index(b"\x00RESIZE:")
                    end = buf.index(b"\n", idx)
                    cmd = buf[idx+8:end].decode()
                    cols, rows = map(int, cmd.split(":"))
                    fcntl.ioctl(pty_fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
                    buf = buf[:idx] + buf[end+1:]
                if buf:
                    os.write(pty_fd, buf)
                    buf = b""