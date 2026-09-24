#!/usr/bin/env python3
"""Local worktree setup and process ownership. Requires Python 3.11+, Node 24 and uv."""

import argparse
from contextlib import contextmanager
import errno
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
import uuid


APP = Path("apps/telomi")
RESEARCH = APP / "services/research-source-service"
HINDSIGHT = APP / "services/hindsight"
AUDIO = Path("apps/telomi-audio-local")
ENV_FILES = (".env", ".env.local", ".env.worktree")
HELD_LOCKS = {}
ADMISSIONS = {}


def output(command, cwd=None, env=None):
    return subprocess.check_output(command, cwd=cwd, env=env, text=True).strip()


def git(root, *args):
    return output(["git", "-C", str(root), *args])


def worktrees(root):
    fields = output(["git", "-C", str(root), "worktree", "list", "--porcelain", "-z"]).split("\0")
    return [Path(field[9:]).resolve() for field in fields if field.startswith("worktree ")]


def context(root):
    root = Path(git(root, "rev-parse", "--show-toplevel")).resolve()
    common = Path(git(root, "rev-parse", "--path-format=absolute", "--git-common-dir"))
    state = common / "telomi-worktrees"
    state.mkdir(mode=0o700, exist_ok=True)
    identity = hashlib.sha256(os.fsencode(root)).hexdigest()[:16]
    return root, worktrees(root)[0], state, identity


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_name(path.name + f".{os.getpid()}.tmp")
    try:
        with temporary.open("x", encoding="utf-8") as file:
            os.chmod(temporary, 0o600)
            file.write(json.dumps(value, indent=2) + "\n")
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


@contextmanager
def admission_gate(state, identity):
    with (state / f"{identity}.gate").open("a+") as file:
        fcntl.flock(file, fcntl.LOCK_EX)
        yield


def epoch(state, identity):
    path = state / f"{identity}.epoch"
    return json.loads(path.read_text()) if path.exists() else 0


def register(root, state, identity):
    if identity not in ADMISSIONS:
        with admission_gate(state, identity):
            if any((state / f"{identity}.{name}").exists() for name in ("stopping", "removing")):
                raise RuntimeError("Worktree teardown is in progress")
            record = state / "waiters" / f"{identity}-{os.getpid()}.json"
            ADMISSIONS[identity] = (record, epoch(state, identity))
            save(record, {"root": str(root), "pid": os.getpid(), "started": process_stamp(os.getpid())})


def validate_admission(state, identity):
    if (ADMISSIONS[identity][1] != epoch(state, identity)
            or any((state / f"{identity}.{name}").exists() for name in ("stopping", "removing"))):
        raise RuntimeError("Queued command cancelled by worktree teardown")


@contextmanager
def locked(path, wait=True):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with path.open("a+") as file:
        fcntl.flock(file, fcntl.LOCK_EX | (0 if wait else fcntl.LOCK_NB))
        # A killed supervisor can leave commands alive after their first child closes its FD.
        while any(str(path) in record.get("locks", []) and group_alive(record)
                  for _file, record in process_records(path.parent)):
            if not wait:
                raise BlockingIOError("Previous command still owns this slot")
            time.sleep(.1)
        HELD_LOCKS[str(path)] = file.fileno()
        try:
            yield
        finally:
            HELD_LOCKS.pop(str(path), None)


def fingerprint(root, files):
    digest = hashlib.sha256()
    for name in sorted(map(str, files)):
        path = root / name
        digest.update(name.encode() + b"\0" + (path.read_bytes() if path.is_file() else b"missing") + b"\0")
    return digest.hexdigest()


def read_env(root):
    # Use Node's parser, never execute dotenv contents as shell code or log secrets.
    script = """const fs = require('node:fs'), {parseEnv} = require('node:util');
const env = {}; for (const f of process.argv.slice(1)) if (fs.existsSync(f)) Object.assign(env, parseEnv(fs.readFileSync(f, 'utf8')));
process.stdout.write(JSON.stringify(env));"""
    return json.loads(output(["node", "-e", script, *[str(root / APP / name) for name in ENV_FILES]],
                             env={**os.environ, "NODE_OPTIONS": "", "NODE_PATH": ""}))


def execution_env(root):
    overlay = read_env(root)
    # Operations owns an isolated Candidate instance; its dynamic ports and data roots must outrank
    # the developer worktree's persistent defaults while all other worktree settings remain available.
    return {**overlay, **os.environ} if os.environ.get("TELOMI_OPERATIONS_EXCHANGE_ROOT") else {**os.environ, **overlay}


def private_copy(source, target):
    if target.exists() or target.is_symlink():
        if target.is_symlink():
            raise RuntimeError(f"Expected a private file, found symlink: {target}")
        return
    if source.is_file():
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with target.open("xb") as file:
            os.chmod(target, 0o600)
            file.write(source.read_bytes())


def unused_ports(count, excluded=()):
    sockets = []
    try:
        ports = []
        while len(ports) < count:
            listener = socket.socket()
            listener.bind(("127.0.0.1", 0))
            sockets.append(listener)
            port = listener.getsockname()[1]
            datagram = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            sockets.append(datagram)
            try:
                datagram.bind(("127.0.0.1", port))
            except OSError as error:
                if error.errno != errno.EADDRINUSE:
                    raise
                continue
            if port not in excluded:
                ports.append(port)
        return ports
    finally:
        for listener in sockets:
            listener.close()


def allocated_ports(state, previous):
    occupied = {port for file in state.glob("*.json") for port in json.loads(file.read_text()).get("ports", [])}
    ports = previous.get("ports", [])
    return ports + unused_ports(11 - len(ports), occupied | set(ports))


def isolation_env(root, source_env, identity, ports):
    api, operations, web, research, audio, chrome, memory, postgres, livekit, rtc_tcp, rtc_udp = ports
    data = root / APP / "data"
    cache = root / APP / "cache"
    agent = data / ".pi/agent"
    kernel = root / APP / ".prime-kernel"
    hf = cache / "huggingface"
    return {
        "TELOMI_DATA_DIR": str(data), "TELOMI_CACHE_DIR": str(cache), "PI_CODING_AGENT_DIR": str(agent),
        "PRIME_AGENT_CODING_AGENT_DIR": str(agent), "HINDSIGHT_BANK_ID": f"telomi-worktree-{identity}",
        "HINDSIGHT_URL": f"http://127.0.0.1:{memory}/v1/default",
        "HINDSIGHT_API_DATABASE_URL": f"pg0://telomi-worktree-{identity}:{postgres}",
        "HINDSIGHT_API_WORKER_ID": f"telomi-worktree-{identity}",
        "HINDSIGHT_API_READ_DATABASE_URL": "", "HINDSIGHT_API_MIGRATION_DATABASE_URL": "",
        "TELOMI_EVAL_INSTANCE": "1", "TELOMI_HOST": "127.0.0.1",
        "PORT": str(api), "API_PORT": str(api), "TELOMI_OPERATIONS_PORT": str(operations),
        "WEB_PORT": str(web), "VITE_API_BASE": f"http://127.0.0.1:{api}",
        "TELOMI_URL": f"http://127.0.0.1:{web}", "TELOMI_WEB_URL": f"http://127.0.0.1:{web}",
        "LIVEKIT_CONFIG": f"{{port: {livekit}, rtc: {{tcp_port: {rtc_tcp}, udp_port: {rtc_udp}}}}}",
        "LIVEKIT_PORT": str(livekit), "LIVEKIT_RTC_TCP_PORT": str(rtc_tcp), "UDP_PORT": str(rtc_udp),
        "LIVEKIT_URL": f"ws://127.0.0.1:{livekit}", "LIVEKIT_PUBLIC_URL": f"ws://127.0.0.1:{livekit}",
        "LIVEKIT_API_KEY": "devkey", "LIVEKIT_API_SECRET": "secret", "LIVEKIT_KEYS": "devkey: secret",
        "TELOMI_RESEARCH_SOURCE_BASE_URL": "", "TELOMI_RESEARCH_SOURCE_SERVICE_TOKEN": "",
        "TELOMI_RESEARCH_SOURCE_SERVICE_DIR": str(root / RESEARCH), "TELOMI_RESEARCH_SOURCE_PORT": str(research),
        "TELOMI_RESEARCH_SOURCE_PYTHON": str(root / RESEARCH / ".venv/bin/python"), "SOURCE_SERVICE_PORT": str(research),
        "SOURCE_SERVICE_MATERIAL_CACHE_BASE_ROOT": "",
        "SOURCE_SERVICE_WORKSPACE_ROOTS": os.pathsep.join(map(str, [data, root / APP, Path(tempfile.gettempdir())])),
        "SOURCE_SERVICE_MATERIAL_CACHE_ROOT": str(cache / "material-cache"),
        "SOURCE_SERVICE_ARXIV_SQLITE_PATH": str(cache / "research-sources/arxiv-runtime.sqlite3"),
        "SOURCE_SERVICE_HF_HOME": str(hf), "HF_HOME": str(hf), "HF_TOKEN_PATH": str(hf / "token"),
        "HF_HUB_CACHE": str(hf / "hub"), "HUGGINGFACE_HUB_CACHE": str(hf / "hub"), "HF_XET_CACHE": str(hf / "xet"),
        "PRIME_AGENT_KERNEL_VENV": str(kernel), "PRIME_AGENT_KERNEL_PYTHON": str(kernel / "bin/python"),
        "TELOMI_HINDSIGHT_EXECUTABLE": str(root / HINDSIGHT / ".venv/bin/hindsight-api"),
        "TELOMI_AUDIO_VENV_PATH": str(root / AUDIO / ".venv"),
        "TELOMI_AUDIO_STT_BASE_URL": f"http://127.0.0.1:{audio}/v1",
        "TELOMI_AUDIO_TTS_BASE_URL": f"http://127.0.0.1:{audio}/v1",
        "TELOMI_AUDIO_ASR_JOB_ROOT": str(data / ".pi/runtime/audio/transcription-jobs"),
        "TELOMI_AUDIO_ASR_INSTALL_STATUS": str(data / ".pi/runtime/audio/asr-install.json"),
        "TELOMI_AUDIO_TTS_INSTALL_STATUS": str(data / ".pi/runtime/audio/tts-install.json"),
        "TELOMI_BROWSER_HOST_CDP_URL": f"http://127.0.0.1:{chrome}", "AGENT_BROWSER_CONFIG": str(data / "agent-browser.json"),
        "TELOMI_BROWSER_NAMESPACE": f"wt-{identity}",
        "AGENT_BROWSER_SOCKET_DIR": str(browser_sockets(identity)), "AGENT_BROWSER_BIN": "",
        "TELOMI_PRIME_AGENT_MODULE_PATH": "", "PRIME_AGENT_MODULE": "",
        "PRIME_AGENT_LOGICAL_WORKSPACE_MODULE_PATH": "",
        "PYTHONPATH": "", "PYTHONHOME": "", "VIRTUAL_ENV": "", "PYTHONNOUSERSITE": "1",
        "UV_PROJECT_ENVIRONMENT": "", "NODE_PATH": "", "NODE_OPTIONS": "",
    }


def agent_browser_config(env):
    """This Worktree's agent-browser CLI config: its own Chrome, never the main checkout's."""
    return {"cdp": env["TELOMI_BROWSER_HOST_CDP_URL"].rsplit(":", 1)[1].rstrip("/")}


def write_agent_browser_config(env):
    # An empty AGENT_BROWSER_CONFIG is read by the CLI as a missing file, and the tracked
    # apps/telomi/agent-browser.json names the main checkout's Chrome; write a private one.
    path = Path(env["AGENT_BROWSER_CONFIG"])
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(agent_browser_config(env), indent=2) + "\n", encoding="utf-8")


def check_agent_browser_config(env):
    if not env.get("AGENT_BROWSER_CONFIG"):
        # An overlay written before Worktrees had their own config: the CLI cannot start, but
        # nothing can reach another checkout's Chrome, so warn instead of blocking running work.
        print("[worktree] agent-browser CLI has no config for this Worktree's Chrome; rerun worktree setup", flush=True)
        return
    path = Path(env["AGENT_BROWSER_CONFIG"])
    try:
        current = json.loads(path.read_text())
    except (OSError, ValueError):
        current = None
    if current != agent_browser_config(env):
        raise RuntimeError(f"agent-browser config does not name this Worktree's Chrome: {path}; rerun worktree setup")


def write_overlay(root, env):
    path = root / APP / ".env.worktree"
    if path.is_symlink():
        raise RuntimeError(f"Worktree overlay must be private: {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as file:
        os.chmod(path, 0o600)
        file.write("# Written by worktree setup; local isolation overrides.\n")
        for key, value in env.items():
            file.write(f"{key}={json.dumps(value, ensure_ascii=False)}\n")


def process_stamp(pid):
    result = subprocess.run(["ps", "-p", str(pid), "-o", "lstart=", "-o", "stat="], text=True, capture_output=True,
                            env={**os.environ, "LC_ALL": "C", "TZ": "UTC"})
    fields = result.stdout.strip().rsplit(None, 1)
    return fields[0] if result.returncode == 0 and len(fields) == 2 and not fields[1].startswith("Z") else ""


def process_records(state):
    for file in (state / "processes").glob("*.json"):
        try:
            yield file, json.loads(file.read_text())
        except FileNotFoundError:
            continue


def group_alive(record):
    stamp = process_stamp(record["pid"])
    if stamp and stamp != record["started"]:
        return False  # Reused PID, no longer our process group.
    return any(int(group) == record["pid"] and not status.startswith("Z")
               for group, status in (line.split() for line in output(["ps", "-axo", "pgid=,stat="]).splitlines()))


def terminate_group(record):
    if not group_alive(record):
        return True
    try:
        os.killpg(record["pid"], signal.SIGTERM)
    except ProcessLookupError:
        return True
    for _ in range(100):
        if not group_alive(record):
            return True
        time.sleep(.1)
    return False  # Keep ownership and refuse removal rather than deleting under a live process.


def check_marker(state):
    raw = os.environ.get("TELOMI_WORKTREE_CHECK_LOCK")
    if not raw:
        return None
    marker = json.loads(raw)
    if marker["path"] != str(state / "check.lock"):
        return None
    if process_stamp(marker["owner"]) != marker["started"]:
        raise RuntimeError("Check supervisor exited; retry from a fresh command")
    parents = dict(tuple(map(int, line.split())) for line in output(["ps", "-axo", "pid=,ppid="]).splitlines())
    pid = os.getpid()
    while pid > 1 and pid != marker["owner"]:
        pid = parents.get(pid, 1)
    if pid != marker["owner"]:
        raise RuntimeError("Check lock marker belongs to another command")
    return marker


def run(command, root, state, identity, env=None, cwd=None):
    """Own a process group so cleanup cannot leave npm/Chrome descendants behind."""
    process = ownership = None
    pending = []
    interrupted = False
    def forward(signum, _frame):
        nonlocal interrupted
        interrupted |= signum == signal.SIGINT
        # A closed terminal hangs up only this supervisor; its own-session command stops as on `stop`.
        signum = signal.SIGTERM if signum == signal.SIGHUP else signum
        if process is None:
            pending.append(signum)  # Arrived while spawning; delivered once the group exists.
            return
        try:
            os.killpg(process.pid, signum)
        except ProcessLookupError:
            pass
    # Forward from the first moment so a Ctrl-C during spawn cannot raise KeyboardInterrupt here
    # and leave the command running without its supervisor.
    handlers = {signum: signal.signal(signum, forward) for signum in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP)}
    try:
        register(root, state, identity)
        with admission_gate(state, identity):
            validate_admission(state, identity)
            process = subprocess.Popen(command, cwd=cwd or root, env=env, start_new_session=True,
                                       pass_fds=tuple(HELD_LOCKS.values()))
            for signum in pending:
                forward(signum, None)
            record = state / "processes" / f"{identity}-{process.pid}.json"
            locks = list(HELD_LOCKS)
            marker = json.loads((env or {}).get("TELOMI_WORKTREE_CHECK_LOCK", "null"))
            if marker:
                locks.append(marker["path"])
            ownership = {"root": str(root), "pid": process.pid, "started": process_stamp(process.pid), "locks": locks}
            save(record, ownership)
        code = process.wait()
        # Ctrl-C is how a foreground service is stopped; a SIGINT death after our own forward is
        # a clean stop, not a failure npm should report. Any other exit status is passed through.
        if interrupted and code in (130, -signal.SIGINT):
            return 0
        return 128 - code if code < 0 else code  # Signal deaths use the shell convention, not a wrapped negative.
    finally:
        stopped = ownership is None or terminate_group(ownership)
        for signum, handler in handlers.items():
            signal.signal(signum, handler)
        if stopped:
            if ownership:
                record.unlink(missing_ok=True)
        else:
            raise RuntimeError("Command descendants are still stopping; ownership retained, run worktree stop again")


def checked(command, root, state, identity, env=None):
    print("[worktree] " + " ".join(command[:5]), flush=True)
    if run(command, root, state, identity, env) != 0:
        raise RuntimeError("Command failed; worktree preserved for retry: " + command[0])


def uv_command(project, python, check=False):
    return ["uv", "sync", "--project", str(project), "--locked", "--python", python,
            *(["--extra", "dev"] if project.name == "research-source-service" else []),
            *(["--check"] if check else [])]


def compatible_venv(root, source, relative, python):
    files = [relative / "pyproject.toml", relative / "uv.lock"]
    if fingerprint(root, files) != fingerprint(source, files):
        return False
    source_env = source / relative / ".venv"
    if not (source_env / "bin/python").exists():
        return False
    env = {**os.environ, "UV_PROJECT_ENVIRONMENT": str(source_env)}
    return subprocess.run(uv_command(source / relative, python, True), env=env,
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0


def prepare_venv(root, source, state, identity, relative, python, share=False):
    target = root / relative / ".venv"
    source_venv = source / relative / ".venv"
    compatible = share and compatible_venv(root, source, relative, python)
    if target.is_symlink():
        if compatible and target.resolve() == source_venv.resolve():
            return
        target.unlink()  # Only remove the link, never its shared target.
    if not target.exists() and compatible:
        target.symlink_to(source_venv.resolve(), target_is_directory=True)
        print(f"[worktree] Shared compatible {relative} environment", flush=True)
    else:
        checked(uv_command(root / relative, python), root, state, identity,
                {**os.environ, "UV_PROJECT_ENVIRONMENT": str(target)})


def prime_info(root):
    script = """import {pathToFileURL} from 'node:url';
import {dirname,join} from 'node:path';
import {primeAgentModulePath} from './server/agent-runtime/prime-agent-paths.ts';
const file=join(dirname(primeAgentModulePath({})), 'core/kernel/bootstrap.js');
const runtime=await import(pathToFileURL(file).href);
process.stdout.write(JSON.stringify({file,identity:await runtime.resolveRuntimeIdentity()}));"""
    env = {**os.environ, **read_env(root)} if (root / APP / ".env.worktree").is_file() else None
    return json.loads(output(["node", "--import", "tsx", "--input-type=module", "-e", script], cwd=root / APP, env=env))


def prepare_prime(root, source, state, identity):
    target = root / APP / ".prime-kernel"
    shared = source / APP / ".prime-kernel"
    info = prime_info(root)
    source_info = prime_info(source)
    version = json.loads((shared / ".bootstrap-version").read_text()) if (shared / ".bootstrap-version").is_file() else {}
    compatible = (shared / "bin/python").exists() and version.get("runtime") == info["identity"] == source_info["identity"]
    compatible = compatible and not version.get("pythonSkills") and Path(info["file"]).read_bytes() == Path(source_info["file"]).read_bytes()
    if target.is_symlink():
        if compatible and target.resolve() == shared.resolve():
            return
        target.unlink()
    if compatible and not target.exists():
        target.symlink_to(shared.resolve(), target_is_directory=True)
        print("[worktree] Shared compatible Prime kernel", flush=True)
    else:
        env = {**os.environ, **read_env(root), "PRIME_AGENT_KERNEL_VENV": str(target), "PRIME_AGENT_KERNEL_PYTHON": ""}
        checked(["npm", "run", "agent-python:install", "--workspace=telomi"], root, state, identity, env)


def setup(root):
    root, source, state, identity = context(root)
    if root == source:
        raise RuntimeError("Run setup inside a linked worktree, or use create from the main checkout.")
    register(root, state, identity)
    with locked(state / "setup.lock"):
        validate_admission(state, identity)
        if output(["node", "-p", "process.versions.node.split('.')[0]"]) != "24":
            raise RuntimeError("Node.js 24 is required")
        for path in (root / APP / "data", root / APP / "data/.pi/agent", root / APP / "data/.pi/agent/accounts", root / APP / "cache"):
            if not path.resolve().is_relative_to(root):
                raise RuntimeError(f"Writable data points outside this worktree: {path}")
        metadata = state / f"{identity}.json"
        previous = json.loads(metadata.read_text()) if metadata.exists() else {}
        source_env = read_env(source)
        source_data = (source / APP / source_env.get("TELOMI_DATA_DIR", "data")).resolve()
        source_env["TELOMI_DATA_DIR"] = str(source_data)
        # An explicit source lets the main checkout develop against its own data while Worktrees
        # still share one login; it is only ever read.
        explicit_agent = source_env.get("TELOMI_CREDENTIALS_SOURCE")
        source_agent = (source / APP / (explicit_agent or source_env.get("PI_CODING_AGENT_DIR", str(source_data / ".pi/agent")))).resolve()
        # Same private-copy set as the evaluation environment seeds into an eval instance: every per-Provider account chain.
        names = ["auth.json", "models.json", "models-store.json", "settings.json", "search-auth.json"]
        names += [f"accounts/{path.name}" for path in sorted((source_agent / "accounts").glob("*.json"))]
        if explicit_agent and not any((source_agent / name).is_file() for name in names):
            raise RuntimeError(f"TELOMI_CREDENTIALS_SOURCE has no credential files: {source_agent}")
        for name in ENV_FILES[:2]:
            private_copy(source / APP / name, root / APP / name)
        agent = root / APP / "data/.pi/agent"
        for name in names:
            private_copy(source_agent / name, agent / name)
        ports = allocated_ports(state, previous)
        overlay = isolation_env(root, source_env, identity, ports)
        # Downloads are shared through the main checkout's cache directory, never its data directory.
        source_cache = source / APP / source_env.get("TELOMI_CACHE_DIR", "cache")
        source_hf = (source / APP / source_env.get("SOURCE_SERVICE_HF_HOME", str(source_cache / "huggingface"))).resolve()
        local_hf = Path(overlay["SOURCE_SERVICE_HF_HOME"])
        local_hf.mkdir(parents=True, exist_ok=True, mode=0o700)
        for name in ("hub", "xet"):
            shared_cache = source_hf / name
            shared_cache.mkdir(parents=True, exist_ok=True)
            destination = local_hf / name
            if destination.is_symlink() and destination.resolve() != shared_cache.resolve():
                destination.unlink()
            if not destination.exists() and not destination.is_symlink():
                destination.symlink_to(shared_cache, target_is_directory=True)
        for name in ("token", "stored_tokens"):
            private_copy(source_hf / name, local_hf / name)
        write_overlay(root, overlay)
        write_agent_browser_config(overlay)
        save(metadata, {**previous, "root": str(root), "source": str(source), "ports": ports})
        packages = ["package.json", "package-lock.json"]
        for pattern in json.loads((root / "package.json").read_text())["workspaces"]:
            packages.extend(str(path.relative_to(root)) for path in root.glob(pattern + "/package.json"))
        npm_hash = fingerprint(root, packages)
        for path in [root / "node_modules", *[root / Path(name).parent / "node_modules" for name in packages if name != "package-lock.json"]]:
            if path.is_symlink():
                path.unlink()
        if previous.get("npm") != npm_hash or not (root / "node_modules/.package-lock.json").exists():
            checked(["npm", "ci", "--prefer-offline", "--no-audit", "--no-fund"], root, state, identity)
            save(metadata, {"root": str(root), "source": str(source), "ports": ports, "npm": npm_hash})
        prepare_venv(root, source, state, identity, RESEARCH, "3.11")
        prepare_venv(root, source, state, identity, HINDSIGHT, "3.11", share=True)
        prepare_venv(root, source, state, identity, AUDIO, "3.12", share=True)
        prepare_prime(root, source, state, identity)
        git(root, "config", "--local", "extensions.worktreeConfig", "true")
        checked(["npm", "run", "install-hook", "--workspace=telomi"], root, state, identity)
        info = prime_info(root)
        save(metadata, {"root": str(root), "source": str(source), "ports": ports, "npm": npm_hash,
                        "primeBootstrap": hashlib.sha256(Path(info["file"]).read_bytes()).hexdigest(),
                        "primeVersion": json.loads((root / APP / ".prime-kernel/.bootstrap-version").read_text())})
    doctor(root)


def doctor(root, live=False):
    root, source, state, identity = context(root)
    if root == source:
        raise RuntimeError("doctor checks a linked worktree, not the main checkout")
    env = read_env(root)
    probe_env = {**os.environ, **env}
    expected_data = root / APP / "data"
    if Path(env.get("TELOMI_DATA_DIR", "")).resolve() != expected_data.resolve():
        raise RuntimeError("Data is not isolated; rerun worktree setup")
    if Path(env.get("TELOMI_CACHE_DIR", "")).resolve() != (root / APP / "cache").resolve():
        raise RuntimeError("Cache is not isolated; rerun worktree setup")
    for path in (expected_data, expected_data / ".pi/agent", root / "node_modules", root / RESEARCH / ".venv"):
        if path.is_symlink() or not path.exists():
            raise RuntimeError(f"Missing or shared source-dependent path: {path}")
    for name in ENV_FILES:
        path = root / APP / name
        if path.is_symlink():
            raise RuntimeError(f"Writable configuration is shared: {path}")
    node_check = """const fs=require('node:fs'),path=require('node:path');
const root=process.cwd(),pkg=require('./package.json');
for(const p of pkg.workspaces){const manifest=require(path.join(root,p,'package.json'));
if(fs.realpathSync(path.join(root,'node_modules',manifest.name))!==fs.realpathSync(path.join(root,p)))throw Error('Workspace dependency points to another checkout: '+manifest.name);}
if(Number(process.versions.node.split('.')[0])!==24)throw Error('Node 24 required');"""
    output(["node", "-e", node_check], cwd=root, env=probe_env)
    module_path = output([str(root / RESEARCH / ".venv/bin/python"), "-c",
                          "import research_source_service; print(research_source_service.__file__)"], cwd=root, env=probe_env)
    if not Path(module_path).resolve().is_relative_to(root / RESEARCH / "src"):
        raise RuntimeError("Research Python imports another checkout; rerun setup")
    for relative, imports in ((APP / ".prime-kernel", ["rlm", "dill"]), (HINDSIGHT / ".venv", ["hindsight_api"]), (AUDIO / ".venv", ["fastapi", "mlx_audio"])):
        output([str(root / relative / "bin/python"), "-c", f"from importlib.util import find_spec; assert all(find_spec(m) for m in {imports!r})"], cwd=root, env=probe_env)
    metadata = json.loads((state / f"{identity}.json").read_text())
    packages = ["package.json", "package-lock.json"]
    for pattern in json.loads((root / "package.json").read_text())["workspaces"]:
        packages.extend(str(path.relative_to(root)) for path in root.glob(pattern + "/package.json"))
    if metadata.get("npm") != fingerprint(root, packages):
        raise RuntimeError("Node dependency manifests changed; rerun worktree setup")
    info = prime_info(root)
    version = json.loads((root / APP / ".prime-kernel/.bootstrap-version").read_text())
    if (info["identity"] != version.get("runtime") or version != metadata.get("primeVersion")
            or hashlib.sha256(Path(info["file"]).read_bytes()).hexdigest() != metadata.get("primeBootstrap")):
        raise RuntimeError("Prime kernel no longer matches the installed SDK; rerun setup")
    for relative in (RESEARCH, HINDSIGHT, AUDIO):
        path = root / relative / ".venv"
        python = "3.12" if relative == AUDIO else "3.11"
        if path.is_symlink():
            if not compatible_venv(root, source, relative, python):
                raise RuntimeError(f"Shared environment no longer matches {relative}; rerun setup")
        elif subprocess.run(uv_command(root / relative, python, True),
                            env={**os.environ, "UV_PROJECT_ENVIRONMENT": str(path)},
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode != 0:
            raise RuntimeError(f"Python dependencies changed in {relative}; rerun setup")
    check_agent_browser_config(env)
    if not (expected_data / ".pi/agent/auth.json").is_file():
        print("[worktree] No copied auth.json; Provider authorization must be configured separately", flush=True)
    if live:
        urls = {"product": f"http://127.0.0.1:{env['PORT']}/api/health",
                "web": env["TELOMI_WEB_URL"],
                "web proxy": env["TELOMI_WEB_URL"] + "/api/health",
                "browser": env["TELOMI_BROWSER_HOST_CDP_URL"].rstrip("/") + "/json/version"}
        for label, url in urls.items():
            with urllib.request.urlopen(url, timeout=5) as response:
                if response.status != 200:
                    raise RuntimeError(f"{label} is not ready")
                if label in {"product", "web proxy"} and Path(json.load(response).get("workspaceDir", "")).resolve() != expected_data.resolve():
                    raise RuntimeError(f"{label} is serving another workspace")
            print(f"[worktree] {label} reachable", flush=True)
    print("[worktree] Ready: local Node/Python source resolution, isolated data/config, Prime/Hindsight/Audio environments", flush=True)
    print(f"[worktree] Web {env['TELOMI_WEB_URL']} | API http://127.0.0.1:{env['PORT']}", flush=True)
    print("[worktree] Browser/Operations availability and live credentials require their actual runtime checks; setup does not run Agents.", flush=True)


def browser_sockets(identity):
    return Path(f"/tmp/telomi-ab-{identity}")


def checked_out(root):
    # Leftover services recreate their own data directories under a deleted checkout, never its Git link.
    return (root / ".git").exists()


def reap_deleted(state):
    """A worktree deleted without stop leaves detached services; its ownership records outlive the checkout."""
    for metadata in state.glob("*.json"):
        try:
            recorded = json.loads(metadata.read_text())
        except (FileNotFoundError, json.JSONDecodeError):
            continue
        if not isinstance(recorded, dict) or "root" not in recorded or checked_out(Path(recorded["root"])):
            continue
        identity = metadata.stem
        try:
            with locked(state / f"{identity}-cleanup.lock", wait=False):
                if metadata.exists():
                    stop_owned(Path(recorded["root"]), state, identity)
                    shutil.rmtree(browser_sockets(identity), ignore_errors=True)
                    metadata.unlink(missing_ok=True)
        except BlockingIOError:
            continue  # Another teardown owns this worktree.
        except (RuntimeError, subprocess.CalledProcessError) as error:
            # Never block an unrelated command; the metadata stays for the next attempt.
            print(f"[worktree] Deleted worktree {recorded['root']} is still stopping: {error}", file=sys.stderr)


def stop(root):
    root, _source, state, identity = context(root)
    with locked(state / f"{identity}-cleanup.lock"):
        stop_owned(root, state, identity)


def stop_owned(root, state, identity):
    barrier = state / f"{identity}.stopping"
    with admission_gate(state, identity):
        barrier.touch(mode=0o600)
        save(state / f"{identity}.epoch", epoch(state, identity) + 1)
    try:
        stop_processes(root, state, identity)
    finally:
        barrier.unlink(missing_ok=True)


def stop_processes(root, state, identity):
    pending = False
    for file in (state / "waiters").glob(f"{identity}-*.json"):
        try:
            waiter = json.loads(file.read_text())
            if waiter["pid"] != os.getpid() and process_stamp(waiter["pid"]) == waiter["started"]:
                os.kill(waiter["pid"], signal.SIGTERM)
        except (FileNotFoundError, ProcessLookupError):
            continue
    for record, data in process_records(state):
        if data["root"] == str(root):
            if terminate_group(data):
                record.unlink(missing_ok=True)
            else:
                pending = True
    # Hindsight detaches its service group. The server reaps it on shutdown; a server killed first
    # leaves it behind. Find it by this worktree's memory port, since its command shape changes.
    metadata = state / f"{identity}.json"
    recorded = json.loads(metadata.read_text()) if metadata.exists() else {}
    ports = recorded.get("ports", [])
    if ports:
        listeners = subprocess.run(["lsof", "-nP", "-t", f"-iTCP:{ports[6]}", "-sTCP:LISTEN"], text=True, capture_output=True)
        for pid in listeners.stdout.split():
            fields = subprocess.run(["ps", "-p", pid, "-o", "pgid=,command="], text=True, capture_output=True).stdout.split(maxsplit=1)
            if len(fields) == 2 and str(root / HINDSIGHT) + "/" in fields[1]:
                group = int(fields[0])
                if not terminate_group({"pid": group, "started": process_stamp(group)}):
                    pending = True
    # Only the Runtime's own Chrome record authorizes stopping a detached browser. A deleted checkout
    # takes that record along; its profile path and recorded CDP port are the remaining evidence.
    # The managed profile lives in the data directory; one started before that layout used the checkout's.
    flags = [f"--user-data-dir={root / APP / path} " for path in ("data/browser-profile", ".chrome-debug-profile")]
    chrome = next((path for path in (root / APP / "data/.pi/runtime/chrome-debug/chrome-debug.json",
                                     root / APP / ".chrome-debug/chrome-debug.json") if path.is_file()), None)
    if chrome:
        pid = json.loads(chrome.read_text()).get("pid", -1)
        browsers = [f"{pid} " + subprocess.run(["ps", "-p", str(pid), "-o", "command="], text=True, capture_output=True).stdout]
        port = "--remote-debugging-port="
    elif ports and not checked_out(root):
        browsers = output(["ps", "-axo", "pid=,command="]).splitlines()
        port = f"--remote-debugging-port={ports[5]} "
    else:
        browsers, port = [], ""
    for line in browsers:
        pid, _, command = line.strip().partition(" ")
        command = command.rstrip() + " "
        if any(flag in command for flag in flags) and port in command:
            if not terminate_group({"pid": int(pid), "started": process_stamp(int(pid))}):
                pending = True
    if pending:
        raise RuntimeError("Owned processes are still shutting down; retry stop before removal")
    for _ in range(100):
        alive = False
        for file in (state / "waiters").glob(f"{identity}-*.json"):
            try:
                waiter = json.loads(file.read_text())
                if waiter["pid"] != os.getpid() and process_stamp(waiter["pid"]) == waiter["started"]:
                    alive = True
                else:
                    file.unlink(missing_ok=True)
            except FileNotFoundError:
                continue
        if not alive:
            # pg0 detaches PostgreSQL from the service process group.
            name = f"telomi-worktree-{identity}"
            if (Path.home() / ".pg0/instances" / name).exists():
                # A deleted checkout took its Hindsight environment; the main checkout provides the same pg0.
                checkout = root if checked_out(root) else Path(recorded["source"])
                subprocess.run([str(checkout / HINDSIGHT / ".venv/bin/python"), "-c",
                                "import sys; from pg0 import Pg0; p=Pg0(name=sys.argv[1]); p.stop(); assert not p.running",
                                name], check=True)
            return
        time.sleep(.1)
    raise RuntimeError("Command supervisors are still shutting down; retry stop")


def seed(root, goal):
    root, source, state, identity = context(root)
    if root == source or not re.fullmatch(r"goal_[A-Za-z0-9_-]+", goal):
        raise RuntimeError("A linked worktree and a valid Goal id are required")
    register(root, state, identity)
    source_env = read_env(source)
    source_data = (source / APP / source_env.get("TELOMI_DATA_DIR", "data")).resolve()
    data = Path(read_env(root)["TELOMI_DATA_DIR"])
    if data.resolve() != root / APP / "data" or (data / goal).exists():
        raise RuntimeError("Snapshot destination is shared or already exists; preserved")
    goals = json.loads((source_data / "goals.json").read_text())
    selected = [value for value in goals if value.get("id") == goal]
    if len(selected) != 1:
        raise RuntimeError("Goal not found in source data")
    def ignore(directory, names):
        return [name for name in names if name in {"node_modules", ".venv", ".prime-kernel", ".git", "locks"} or (Path(directory) / name).is_symlink()]
    with locked(state / f"{identity}-seed.lock"):
        validate_admission(state, identity)
        shutil.copytree(source_data / goal, data / goal, ignore=ignore)
        history = Path(".pi/runtime/harness") / goal
        if (source_data / history).is_dir():
            shutil.copytree(source_data / history, data / history, ignore=ignore)
        target = data / "goals.json"
        existing = json.loads(target.read_text()) if target.exists() else []
        save(target, [value for value in existing if value.get("id") != goal] + selected)
    print(f"[worktree] Copied {goal} and its existing history; no Agent started", flush=True)


def main():
    # Git hooks export paths relative to their initial cwd. Preserve that meaning
    # before git -C and managed commands change directories, including nested hooks.
    for name in ("GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY"):
        if os.environ.get(name):
            os.environ[name] = os.path.abspath(os.environ[name])
    if os.environ.get("GIT_DIR") and not os.environ.get("GIT_WORK_TREE"):
        os.environ["GIT_WORK_TREE"] = git(Path.cwd(), "rev-parse", "--show-toplevel")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", default=os.getcwd())
    sub = parser.add_subparsers(dest="action", required=True)
    create = sub.add_parser("create")
    create.add_argument("path")
    create.add_argument("--branch", required=True)
    create.add_argument("--base", default="dev", help="Starting commit or branch (default: dev; use main for hotfixes)")
    for name in ("setup", "stop", "remove"):
        sub.add_parser(name)
    sub.add_parser("doctor").add_argument("--live", action="store_true")
    sub.add_parser("seed").add_argument("goal")
    for name in ("run", "check", "launch"):
        sub.add_parser(name).add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    root, source, state, identity = context(args.root)
    reap_deleted(state)
    if args.action == "launch":
        command = args.command[1:] if args.command[:1] == ["--"] else args.command
        if not command:
            parser.error("A command is required after --")
        if root != source and not (root / APP / ".env.worktree").is_file():
            raise RuntimeError("Worktree is not initialized; run npm run worktree -- setup before starting services")
        # Nested npm scripts stay in their owner's process group and consume no extra slot.
        if any(record["root"] == str(root) and record["pid"] == os.getpgrp() and group_alive(record)
               for _file, record in process_records(state)):
            env = execution_env(root) if root != source else dict(os.environ)
            os.execvpe(command[0], command, env)
        args.action = "run"
    if args.action in {"create", "setup", "run", "check", "seed"}:
        register(root, state, identity)
    if args.action == "create":
        target = Path(args.path).absolute()
        if target.resolve().is_relative_to(source):
            raise RuntimeError("Create worktrees outside the main checkout")
        git(root, "check-ref-format", "--branch", args.branch)
        base = git(root, "rev-parse", "--verify", "--end-of-options", args.base + "^{commit}")
        checked(["git", "worktree", "add", "-b", args.branch, str(target), base], root, state, identity)
        setup(target)
    elif args.action == "setup":
        setup(root)
    elif args.action == "doctor":
        doctor(root, args.live)
    elif args.action == "seed":
        seed(root, args.goal)
    elif args.action == "stop":
        stop(root)
    elif args.action == "remove":
        if root == source:
            raise RuntimeError("Cannot remove the main checkout")
        if git(root, "branch", "--show-current") in {"main", "dev"}:
            raise RuntimeError("Cannot remove a main or dev worktree")
        if git(root, "status", "--porcelain", "--untracked-files=all"):
            raise RuntimeError("Worktree has uncommitted files; preserved")
        merged = git(source, "branch", "--contains", git(root, "rev-parse", "HEAD"), "--format=%(refname)").splitlines()
        if not {"refs/heads/dev", "refs/heads/main"}.intersection(merged):
            raise RuntimeError("Worktree HEAD is not merged into dev or main; preserved")
        previous_epoch = epoch(state, identity)
        with locked(state / f"{identity}-cleanup.lock"):
            if previous_epoch != epoch(state, identity):
                raise RuntimeError("Another teardown changed this worktree; retry after it finishes")
            barrier = state / f"{identity}.removing"
            with admission_gate(state, identity):
                barrier.touch(mode=0o600)
            try:
                stop_owned(root, state, identity)
                subprocess.run(["git", "worktree", "remove", str(root)], cwd=source, check=True)
                shutil.rmtree(browser_sockets(identity), ignore_errors=True)
                (state / f"{identity}.json").unlink(missing_ok=True)
            finally:
                barrier.unlink(missing_ok=True)
    else:
        command = args.command[1:] if args.command[:1] == ["--"] else args.command
        if not command:
            parser.error("A command is required after --")
        cwd = Path(args.root).resolve()
        env = execution_env(root) if root != source else dict(os.environ)
        if args.action == "check":
            marker = check_marker(state)
            if marker:
                marker = {**marker, "depth": marker["depth"] + 1}
                path = state / f"check-{marker['token']}-{marker['depth']}.lock"
            else:
                path = state / "check.lock"
                marker = {"path": str(path), "owner": os.getpid(), "started": process_stamp(os.getpid()),
                          "depth": 0, "token": uuid.uuid4().hex}
            with locked(path):
                return run(command, root, state, identity, {**env, "TELOMI_WORKTREE_CHECK_LOCK": json.dumps(marker)}, cwd)
        for slot in range(3):
            try:
                with locked(state / f"run-{slot}.lock", wait=False):
                    if root != source:
                        doctor(root)
                    return run(command, root, state, identity, env, cwd)
            except BlockingIOError:
                continue
        raise RuntimeError("All 3 worktree run slots are occupied; wait for a command to finish")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (RuntimeError, subprocess.CalledProcessError, OSError, ValueError) as error:
        print(f"[worktree] {error}", file=sys.stderr)
        sys.exit(1)
    finally:
        for record, _epoch in ADMISSIONS.values():
            record.unlink(missing_ok=True)
