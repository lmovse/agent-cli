#!/usr/bin/env python3
# PTY wrapper for Obsidian terminal
import sys
import os

if sys.platform != "win32":
    from fcntl import ioctl as _ioctl
    import pty as _pty
    from termios import TIOCSWINSZ as _TIOCSWINSZ
    from struct import pack as _pack
    from selectors import DefaultSelector as _DefaultSelector, EVENT_READ as _EVENT_READ

    _FORK = _pty.fork
    _CHUNK_SIZE = 1024
    _STDIN = sys.stdin.fileno()
    _STDOUT = sys.stdout.fileno()
    _CMDIO = 3

    def main():
        pid, pty_fd = _FORK()
        if pid == 0:
            os.execvp(sys.argv[1], sys.argv[1:])

        def write_all(fd, data):
            while data:
                data = data[os.write(fd, data):]

        with _DefaultSelector() as selector:
            running = True

            def pipe_pty():
                try:
                    data = os.read(pty_fd, _CHUNK_SIZE)
                except OSError:
                    data = b""
                if not data:
                    selector.unregister(pty_fd)
                    running = False
                    return
                write_all(_STDOUT, data)

            def pipe_stdin():
                data = os.read(_STDIN, _CHUNK_SIZE)
                if not data:
                    selector.unregister(_STDIN)
                    return
                write_all(pty_fd, data)

            def process_cmdio():
                data = os.read(_CMDIO, _CHUNK_SIZE)
                if not data:
                    selector.unregister(_CMDIO)
                    return
                for line in data.decode("UTF-8", "strict").splitlines():
                    rows, columns = (int(ss.strip()) for ss in line.split("x", 2))
                    ioctl(
                        pty_fd,
                        _TIOCSWINSZ,
                        _pack("HHHH", columns, rows, 0, 0),
                    )

            selector.register(pty_fd, _EVENT_READ, pipe_pty)
            selector.register(_STDIN, _EVENT_READ, pipe_stdin)
            selector.register(_CMDIO, _EVENT_READ, process_cmdio)
            while running:
                for key, _ in selector.select():
                    key.data()

        os._exit(os.waitpid(pid, 0)[1])

    def ioctl(fd, request, arg):
        try:
            return _ioctl(fd, request, arg)
        except OSError:
            pass

    if __name__ == "__main__":
        main()
