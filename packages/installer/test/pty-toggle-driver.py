#!/usr/bin/env python3
# Drive install.sh's interactive checkbox UI through a real pty so we can test the toggle
# selection (arrow keys / space / enter) the way a human uses it. Not importable logic — the UI
# reads /dev/tty and only works with a controlling terminal, which a pty provides.
#
# Usage: pty-toggle-driver.py <install.sh> <keys>
#   <keys> = comma-separated tokens sent one at a time: up down space enter a n q, or a literal char.
# Inherits PATH + CALLLOG from the environment (the caller stages fake bins + a call log).
import os, pty, sys, time, select

INSTALL = sys.argv[1]
KEYS = [k for k in sys.argv[2].split(",") if k] if len(sys.argv) > 2 else []

SEQ = {"up": b"\x1b[A", "down": b"\x1b[B", "space": b" ", "enter": b"\r"}

def drain(fd, quiet=0.4):
    out = b""; end = time.time() + quiet
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.05)
        if r:
            try:
                d = os.read(fd, 4096)
            except OSError:
                break
            if not d:
                break
            out += d; end = time.time() + quiet
    return out

pid, fd = pty.fork()
if pid == 0:
    os.execvpe("bash", ["bash", INSTALL], os.environ)

buf = drain(fd, 1.0)
for tok in KEYS:
    os.write(fd, SEQ.get(tok, tok.encode()))
    time.sleep(0.15)
    buf += drain(fd, 0.3)
buf += drain(fd, 1.0)
try:
    os.waitpid(pid, 0)
except OSError:
    pass
# Emit the full pty transcript on stdout so the caller can assert on what the user would see.
sys.stdout.write(buf.decode(errors="replace"))
