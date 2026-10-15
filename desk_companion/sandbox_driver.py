"""Trusted WSL supervisor. Never import the application or pass its environment to a command.

The control directory is outside the sandbox. Only /usr and the workspace are mounted.
All child bytes are framed here, so terminal output cannot forge supervisor events.
"""
import base64
import json
import os
from pathlib import Path
import select
import signal
import struct
import subprocess
import sys
import time

# The application discovers/imports all backend modules on Windows too.
if sys.platform == "linux":
    import fcntl
    import pty
    import resource
    import termios

OUTPUT_LIMIT = 4 * 1024 * 1024
WORKSPACE_LIMIT = 128 * 1024 * 1024


def sandbox_args(workspace, command, cwd="/workspace", references=None):
    args = ["/usr/bin/bwrap", "--unshare-all", "--unshare-user", "--disable-userns", "--assert-userns-disabled",
            "--die-with-parent", "--new-session", "--cap-drop", "ALL", "--clearenv",
            "--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin",
            "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64",
            "--proc", "/proc", "--dev", "/dev", "--size", "67108864", "--tmpfs", "/tmp",
            "--bind", str(workspace), "/workspace", "--chdir", cwd,
            "--setenv", "PATH", "/usr/bin:/bin", "--setenv", "HOME", "/tmp",
            "--setenv", "LANG", "C.UTF-8", "--setenv", "TERM", "xterm-256color",
            "--setenv", "PYTHONUNBUFFERED", "1", "--remount-ro", "/", "--",
            "/usr/bin/python3", "-c",
            "import os,fcntl,termios,sys\n"
            "try: os.setsid()\nexcept PermissionError: pass\n"
            "fcntl.ioctl(0,termios.TIOCSCTTY,0)\n"
            "os.execv('/bin/bash',['bash','--noprofile','--norc','-c',sys.argv[1]])", command]
    if references:
        position = args.index('--chdir')
        mounts = ['--dir', '/references']
        for i, path in enumerate(references): mounts += ['--ro-bind', str(path), f'/references/{i}']
        args[position:position] = mounts
    return args


def emit(**values):
    print(json.dumps(values), flush=True)


def limits(project=False):
    resource.setrlimit(resource.RLIMIT_AS, (2048 * 1024**2, 2048 * 1024**2) if project else (256 * 1024**2, 256 * 1024**2))
    resource.setrlimit(resource.RLIMIT_NPROC, (64, 64))
    resource.setrlimit(resource.RLIMIT_NOFILE, (256, 256))
    resource.setrlimit(resource.RLIMIT_FSIZE, (32 * 1024**2, 32 * 1024**2))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_CPU, (120, 120) if project else (60, 60))


def workspace_size(path, project=False):
    size = count = 0
    for parent, dirs, files in os.walk(path, followlinks=False):
        count += len(dirs) + len(files)
        for name in files:
            try:
                size += (Path(parent) / name).lstat().st_size
            except FileNotFoundError:
                pass
        if size > (2*1024**3 if project else WORKSPACE_LIMIT) or count > (150000 if project else 10000):
            return False
    return True


def lease_alive(path, clock, now):
    # Host and WSL wall clocks can differ. Observe heartbeat changes using only
    # the supervisor's monotonic clock, never subtract a host file time.
    stamp = path.stat().st_mtime_ns
    if clock.get('stamp') != stamp:
        clock.update(stamp=stamp, observed=now)
    return now - clock['observed'] <= 8


def main(control):
    if sys.platform != "linux":
        raise RuntimeError("沙箱监督进程须在 Linux/WSL 内运行。")
    control = Path(control)
    request = json.loads((control / "request.json").read_text())
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
    process = None
    reason = ""
    total = position = 0
    pending = bytearray()
    started = time.monotonic()
    last_size = 0
    lease_clock = {}
    try:
        process = subprocess.Popen(sandbox_args(request["workspace"], request["command"], request["cwd"], request.get("references")),
                                   stdin=slave, stdout=slave, stderr=slave,
                                   start_new_session=True, preexec_fn=lambda: limits(request.get("project", False)),
                                   env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"})
        os.close(slave); slave = -1
        os.set_blocking(master, False)
        emit(kind="started")
        with (control / "input.jsonl").open("rb") as inputs:
            while True:
                now = time.monotonic()
                if (control / "stop").exists():
                    reason = "cancelled"
                elif now - started > request["timeout"]:
                    reason = "timed_out"
                elif not lease_alive(control / "lease", lease_clock, now):
                    reason = "interrupted"
                elif now - last_size > 1:
                    last_size = now
                    if not workspace_size(request["workspace"], request.get("project", False)):
                        reason = "workspace_limit"
                if reason:
                    break
                inputs.seek(position)
                for line in inputs:
                    if not line.endswith(b"\n"):
                        break
                    value = json.loads(line)
                    if "size" in value:
                        cols, rows = value["size"]
                        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
                    else:
                        pending.extend(base64.b64decode(value["data"]))
                    position = inputs.tell()
                if pending:
                    if len(pending) > 65536:
                        reason = "input_limit"
                        break
                    if select.select([], [master], [], 0)[1]:
                        try:
                            written = os.write(master, pending)
                            del pending[:written]
                        except BlockingIOError:
                            pass
                if select.select([master], [], [], .05)[0]:
                    try:
                        data = os.read(master, 8192)
                    except OSError:
                        data = b""
                    if data:
                        total += len(data)
                        if total > OUTPUT_LIMIT:
                            reason = "output_limit"
                            break
                        emit(kind="output", data=base64.b64encode(data).decode())
                    elif process.poll() is not None:
                        break
                elif process.poll() is not None:
                    break
    finally:
        if process:
            # Kill bwrap itself (not just its Bash child). PID namespace teardown removes descendants.
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGKILL)
            code = process.wait()
        else:
            code = -1
        os.close(master)
        if slave >= 0:
            os.close(slave)
        (control / "input.jsonl").unlink(missing_ok=True)
        emit(kind="exit", state=reason or ("succeeded" if code == 0 else "failed"), exit_code=code)


if __name__ == "__main__":
    try:
        main(sys.argv[1])
    except Exception as exc:
        emit(kind="error", message=f"沙箱监督进程失败：{type(exc).__name__}: {exc}")
