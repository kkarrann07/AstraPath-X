"""Local browser launcher. Its bootstrap uses only the Python standard library."""
from contextlib import contextmanager
from hashlib import sha256
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
from urllib.error import URLError
from urllib.request import ProxyHandler, build_opener
import webbrowser


ROOT = Path(__file__).resolve().parent.parent
VENV = ROOT / ".venv"
RUNTIME = ROOT / ".astrapath-local.json"
DEFAULT_PORT = 8765
LOCAL_REQUEST = build_opener(ProxyHandler({}))
WORKSPACE_ID = sha256(os.path.normcase(str(ROOT)).encode()).hexdigest()


@contextmanager
def startup_lock():
    import msvcrt

    with (ROOT / ".astrapath-launch.lock").open("a+b") as lock:
        if lock.tell() == 0:
            lock.write(b"0")
            lock.flush()
        lock.seek(0)
        try:
            msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError:
            yield False
            return
        try:
            yield True
        finally:
            lock.seek(0)
            msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)


def browser_url(port):
    return f"http://127.0.0.1:{port}/"


def is_astrapath(port):
    try:
        with LOCAL_REQUEST.open(browser_url(port) + "health", timeout=0.35) as response:
            return response.headers.get("X-AstraPath-Workspace") == WORKSPACE_ID
    except (OSError, URLError):
        return False


def running_port():
    try:
        remembered = json.loads(RUNTIME.read_text(encoding="utf-8")).get("port")
    except (ValueError, OSError, AttributeError):
        remembered = None
    for port in (remembered, DEFAULT_PORT):
        if isinstance(port, int) and 0 < port < 65536 and is_astrapath(port):
            return port
    return None


def open_dashboard(port):
    url = browser_url(port)
    print(f"AstraPath-X is ready at {url}", flush=True)
    try:
        opened = webbrowser.open(url, new=2)
    except webbrowser.Error:
        opened = False
    if not opened:
        print("The default browser could not be opened. Paste the address above into your browser.", flush=True)


def install_dependencies():
    executable = VENV / "Scripts" / "python.exe"
    if not executable.is_file() or subprocess.run(
        [str(executable), "-c", "import sys; raise SystemExit(not ((3,12) <= sys.version_info[:2] <= (3,14)))"],
        capture_output=True,
    ).returncode:
        print("Creating the local Python environment…", flush=True)
        subprocess.run([sys.executable, "-m", "venv", str(VENV)], cwd=ROOT, check=True)

    fingerprint = sha256((ROOT / "requirements.txt").read_bytes()).hexdigest()
    stamp = VENV / ".astrapath-dependencies"
    try:
        installed = stamp.read_text(encoding="ascii").strip() == fingerprint
    except OSError:
        installed = False
    if installed:
        installed = subprocess.run(
            [str(executable), "-c", "import fastapi, uvicorn, numpy, rasterio, python_multipart"],
            capture_output=True,
        ).returncode == 0
    if not installed:
        print("Installing AstraPath-X dependencies. The first launch needs internet access.", flush=True)
        subprocess.run([str(executable), "-m", "pip", "install", "--disable-pip-version-check",
                        "-r", "requirements.txt"], cwd=ROOT, check=True)
        subprocess.run([str(executable), "-m", "pip", "check"], cwd=ROOT, check=True)
        stamp.write_text(fingerprint, encoding="ascii")
    return executable


def available_port():
    with socket.socket() as listener:
        try:
            listener.bind(("127.0.0.1", DEFAULT_PORT))
        except OSError:
            listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


def serve(executable):
    port = available_port()
    env = {**os.environ, "PYTHONUNBUFFERED": "1", "ASTRAPATH_SAVE_LOCAL": "1"}
    env.pop("PYTHONPATH", None)
    server = subprocess.Popen([str(executable), "-m", "uvicorn", "astrapath.api:app",
                               "--host", "127.0.0.1", "--port", str(port)], cwd=ROOT, env=env)
    try:
        for _ in range(120):
            if server.poll() is not None:
                raise RuntimeError(f"The web server exited with code {server.returncode}.")
            if is_astrapath(port):
                RUNTIME.write_text(json.dumps({"port": port}), encoding="ascii")
                open_dashboard(port)
                print("Keep this window open while using the dashboard. Closing it stops this server.", flush=True)
                return server.wait()
            time.sleep(0.25)
        raise RuntimeError("The web server did not become ready. Review the startup output above.")
    finally:
        if server.poll() is None:
            server.terminate()
            server.wait(timeout=5)
        RUNTIME.unlink(missing_ok=True)


def main():
    try:
        if os.name != "nt":
            raise RuntimeError("Use Start_AstraPath.bat on Windows.")
        with startup_lock() as acquired:
            port = running_port()
            if port:
                open_dashboard(port)
                return 0
            if not acquired:
                print("Another launcher is starting AstraPath-X. Waiting for it to finish…", flush=True)
                for _ in range(90):
                    time.sleep(1)
                    port = running_port()
                    if port:
                        open_dashboard(port)
                        return 0
                raise RuntimeError("Check the original launcher window for progress or an error.")
            return serve(install_dependencies())
    except subprocess.CalledProcessError as error:
        print(f"Python environment setup failed with exit code {error.returncode}. "
              "Check that Python can write to this folder and reach the package index.", file=sys.stderr)
    except KeyboardInterrupt:
        return 0
    except (OSError, RuntimeError, subprocess.TimeoutExpired) as error:
        print(f"Startup failed: {error}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
