"""Deterministic Git/filesystem/process checks; no dependency downloads or Providers."""
from contextlib import ExitStack
import importlib.util
import io
import json
import os
import shutil
import signal
import socket
import urllib.request
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).with_name("worktree.py")
spec = importlib.util.spec_from_file_location("worktree", SCRIPT)
wt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wt)


class WorktreeTest(unittest.TestCase):
    def setUp(self):
        clean = patch.dict(os.environ, {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}, clear=True)
        clean.start()
        self.addCleanup(clean.stop)
        self.temporary = tempfile.TemporaryDirectory(prefix="telomi worktree test ")
        self.addCleanup(self.temporary.cleanup)
        self.main = Path(self.temporary.name).resolve() / "main"
        self.main.mkdir()
        self.git("init", "-b", "main")
        self.git("config", "user.email", "test@example.invalid")
        self.git("config", "user.name", "Worktree test")
        self.git("config", "core.hooksPath", "/dev/null")
        (self.main / ".gitignore").write_text(".env*\ndata/\n")
        (self.main / "package.json").write_text('{"workspaces":[]}')
        (self.main / wt.APP).mkdir(parents=True)
        (self.main / wt.APP / "placeholder").write_text("tracked")
        self.git("add", ".")
        self.git("commit", "-qm", "fixture")
        self.git("branch", "dev")
        self.root = Path(self.temporary.name).resolve() / "linked space"
        self.git("worktree", "add", "-b", "codex/test", str(self.root))
        _, _, self.state, self.identity = wt.context(self.root)

    def git(self, *args):
        return subprocess.check_output(["git", "-C", str(self.main), *args], text=True, stderr=subprocess.DEVNULL)

    def cli(self, *args, root=None):
        return subprocess.run([sys.executable, str(SCRIPT), "--root", str(root or self.root), *args], capture_output=True, text=True)

    def test_npm_service_restart_is_isolated_from_sibling_and_parent_environment(self):
        # Exercise the public npm entrypoint and real HTTP processes. Only dependency
        # installation probes and the expensive product runtime are replaced.
        second = Path(self.temporary.name).resolve() / "sibling"
        self.git("worktree", "add", "-b", "codex/sibling", str(second))
        ports = wt.unused_ports(3)
        processes = []
        source_app = SCRIPT.parent.parent
        for root, port in zip((self.root, second), ports):
            app = root / wt.APP
            (app / "scripts").mkdir()
            launcher = SCRIPT.read_text().replace("def doctor(root, live=False):", "def doctor(root, live=False):\n    return\n\ndef unused_doctor(root, live=False):")
            (app / "scripts/worktree.py").write_text(launcher)
            shutil.copy(source_app / "package.json", app / "package.json")
            (app / "node_modules").symlink_to(source_app / "node_modules", target_is_directory=True)
            # npm hoists deps shared by two workspaces to the repo root; node resolves tsx from there.
            (root / "node_modules").symlink_to(source_app.parent.parent / "node_modules", target_is_directory=True)
            (app / "server").mkdir()
            (app / "server/index.ts").write_text("import http from 'node:http'; http.createServer((q,s)=>s.end(String(process.pid))).listen(Number(process.env.PORT),'127.0.0.1');")
            (app / ".env.worktree").write_text(f"PORT={port}\n")

        def start(root, managed=False):
            command = ["npm", "start", "--silent"]
            if managed:
                command = [sys.executable, "scripts/worktree.py", "run", "--", *command]
            process = subprocess.Popen(command, cwd=root / wt.APP,
                                       env={**os.environ, "PORT": str(ports[2])},
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
            processes.append(process)
            return process

        def response(port):
            with urllib.request.urlopen(f"http://127.0.0.1:{port}", timeout=.5) as result:
                return result.read()

        # npm -> worktree launch -> node/tsx 的启动时间随机器负载变化，固定轮数会在忙碌机器上误报。
        # 用挂钟期限等待，并把退出码与子进程输出带进失败信息，区分启动慢和启动失败。
        def ready(port, process):
            deadline = time.monotonic() + 60
            while True:
                try:
                    return response(port)
                except OSError as error:
                    last_error = error
                if process.poll() is not None:
                    self.fail(f"npm start exited with {process.returncode} before binding port {port}: {output(process)}")
                if time.monotonic() >= deadline:
                    self.fail(f"npm start did not bind its worktree port {port} within 60s ({last_error}); "
                              "parent PORT must not override isolation")
                time.sleep(.05)

        def output(process):
            try:
                return b"".join(stream or b"" for stream in process.communicate(timeout=10)).decode(errors="replace")
            except subprocess.TimeoutExpired:
                return "<still held open by a descendant>"

        try:
            first = start(self.root)
            first_pid = ready(ports[0], first)
            sibling = start(second)
            sibling_pid = ready(ports[1], sibling)
            for _ in range(2):
                stopped = self.cli("stop")
                self.assertEqual(stopped.returncode, 0, stopped.stderr)
                first.communicate(timeout=10)
                self.assertEqual(response(ports[1]), sibling_pid)
                first = start(self.root, managed=True)
                self.assertNotEqual(ready(ports[0], first), first_pid)
                self.assertEqual(response(ports[1]), sibling_pid)
                self.assertEqual(sum(record["root"] == str(self.root) for _, record in wt.process_records(self.state)), 1)
            self.assertEqual(self.cli("stop").returncode, 0)
            first.communicate(timeout=10)
            overlay = self.root / wt.APP / ".env.worktree"
            overlay.write_text(f"PORT={ports[1]}\n")
            conflict = start(self.root)
            _, error = conflict.communicate(timeout=10)
            self.assertNotEqual(conflict.returncode, 0)
            self.assertIn(b"EADDRINUSE", error)
            self.assertEqual(response(ports[1]), sibling_pid)
            overlay.unlink()
            uninitialized = start(self.root)
            _, error = uninitialized.communicate(timeout=10)
            self.assertNotEqual(uninitialized.returncode, 0)
            self.assertIn(b"worktree -- setup", error)
            self.assertEqual(response(ports[1]), sibling_pid)
        finally:
            for root in (self.root, second):
                self.cli("stop", root=root)
            for process in processes:
                if process.poll() is None:
                    try:
                        os.killpg(process.pid, 15)
                    except (PermissionError, ProcessLookupError):
                        pass  # `stop` already ended the group; the leader exited between poll() and killpg().
                process.communicate(timeout=10)

    def test_context_and_private_environment(self):
        self.assertEqual(wt.context(self.root)[1], self.main)
        source = self.main / wt.APP / ".env"
        source.write_text('SECRET="a value with spaces"\nPORT=8787\n')
        target = self.root / wt.APP / ".env"
        wt.private_copy(source, target)
        self.assertFalse(target.is_symlink())
        self.assertEqual(target.stat().st_mode & 0o777, 0o600)
        values = wt.isolation_env(self.root, {"TELOMI_DATA_DIR": str(self.main / "private")}, self.identity, range(21000, 21011))
        self.assertTrue(Path(values["AGENT_BROWSER_SOCKET_DIR"]).is_absolute())
        # The server runs its own agent-browser package; an inherited override, or the global command, never reaches it.
        self.assertEqual(values["AGENT_BROWSER_BIN"], "")
        self.assertIn(self.identity, values["TELOMI_BROWSER_NAMESPACE"])
        wt.write_overlay(self.root, values)
        loaded = wt.read_env(self.root)
        self.assertEqual(loaded["SECRET"], "a value with spaces")
        self.assertEqual(loaded["PORT"], "21000")
        self.assertEqual(loaded["SOURCE_SERVICE_PORT"], loaded["TELOMI_RESEARCH_SOURCE_PORT"])
        livekit = wt.output(["node", "-e", "console.log(JSON.stringify(require('yaml').parse(process.argv[1])))", loaded["LIVEKIT_CONFIG"]], cwd=SCRIPT.parent.parent)
        self.assertEqual(json.loads(livekit), {"port": 21008, "rtc": {"tcp_port": 21009, "udp_port": 21010}})
        self.assertEqual(loaded["LIVEKIT_URL"], "ws://127.0.0.1:21008")
        self.assertEqual(loaded["UDP_PORT"], "21010")
        self.assertEqual(loaded["LIVEKIT_PORT"], "21008")
        self.assertEqual(loaded["LIVEKIT_RTC_TCP_PORT"], "21009")
        self.assertEqual(loaded["LIVEKIT_KEYS"], f"{loaded['LIVEKIT_API_KEY']}: {loaded['LIVEKIT_API_SECRET']}")
        self.assertEqual(loaded["TELOMI_DATA_DIR"], str(self.root / wt.APP / "data"))
        target.write_text('SECRET="edited"')
        wt.private_copy(source, target)
        self.assertIn("edited", target.read_text())
        self.assertIn("a value", source.read_text())
        linked = self.root / wt.APP / ".env.local"
        linked.symlink_to(source)
        with self.assertRaisesRegex(RuntimeError, "symlink"):
            wt.private_copy(source, linked)

    def test_stop_reaps_only_owned_detached_hindsight_listener(self):
        # Real detached listeners on the memory port; ownership follows the checkout, not a command shape.
        port, = wt.unused_ports(1)
        wt.save(self.state / f"{self.identity}.json", {"ports": [0] * 6 + [port, 0]})
        serve = ("import socket, sys, time; s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); "
                 "s.bind(('127.0.0.1', int(sys.argv[2]))); s.listen(); time.sleep(60)")
        for checkout, owned in ((self.main, False), (self.root, True)):
            with self.subTest(owned=owned):
                service = subprocess.Popen([sys.executable, "-c", serve, str(checkout / wt.HINDSIGHT / "telomi_configuration.py"), str(port)],
                                           start_new_session=True)
                self.addCleanup(service.kill)
                while subprocess.run(["lsof", "-t", f"-iTCP:{port}", "-sTCP:LISTEN"], capture_output=True).returncode:
                    self.assertIsNone(service.poll())
                    time.sleep(.05)
                wt.stop_processes(self.root, self.state, self.identity)
                if owned:
                    self.assertEqual(service.wait(timeout=5), -15)
                else:
                    self.assertIsNone(service.poll())
                    service.kill()
                    service.wait()

    def test_terminal_hangup_stops_owned_command_gracefully(self):
        # A closed terminal hangs up only the supervisor; its own-session command must still stop gracefully.
        started, stopped = self.root / "started.txt", self.root / "stopped.txt"
        code = ("import pathlib, signal, sys, time; "
                "signal.signal(signal.SIGTERM, lambda *_: (pathlib.Path(%r).touch(), sys.exit(0))); "
                "pathlib.Path(%r).touch(); time.sleep(60)") % (str(stopped), str(started))
        supervisor = subprocess.Popen([sys.executable, str(SCRIPT), "--root", str(self.root), "check", "--", sys.executable, "-c", code],
                                      stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.addCleanup(self.cli, "stop")
        self.addCleanup(lambda: supervisor.poll() is None and supervisor.kill())
        while not started.exists():
            self.assertIsNone(supervisor.poll())
            time.sleep(.02)
        supervisor.send_signal(signal.SIGHUP)
        # Generous: this test also runs inside the real hook, where the full suite
        # saturates the machine. Graceful shutdown takes ~0.5s on an idle one.
        supervisor.communicate(timeout=60)
        self.assertTrue(stopped.exists())
        self.assertEqual(list((self.state / "processes").glob("*.json")), [])

    def test_any_command_reaps_a_worktree_deleted_without_stop(self):
        # Ownership records live in the common Git directory and outlive the deleted checkout.
        chrome_port, memory_port = wt.unused_ports(2)
        wt.save(self.state / f"{self.identity}.json",
                {"root": str(self.root), "source": str(self.main), "ports": [0] * 5 + [chrome_port, memory_port, 0]})
        sleep = [sys.executable, "-c", "import time; time.sleep(60)"]
        command = subprocess.Popen(sleep, start_new_session=True)
        profile = self.root / wt.APP / ".chrome-debug-profile"
        chrome = subprocess.Popen([*sleep, f"--remote-debugging-port={chrome_port}", f"--user-data-dir={profile}"], start_new_session=True)
        for process in (command, chrome):
            self.addCleanup(lambda process=process: process.poll() is None and process.kill())
        wt.save(self.state / "processes" / f"{self.identity}-{command.pid}.json",
                {"root": str(self.root), "pid": command.pid, "started": wt.process_stamp(command.pid), "locks": []})
        sockets = Path(f"/tmp/telomi-ab-{self.identity}")
        sockets.mkdir()
        self.addCleanup(shutil.rmtree, sockets, True)
        self.git("worktree", "remove", "--force", str(self.root))
        profile.mkdir(parents=True)  # A leftover browser recreates its profile under the deleted checkout.
        self.cli("doctor", root=self.main)
        self.assertEqual(command.wait(timeout=10), -15)
        self.assertEqual(chrome.wait(timeout=10), -15)
        self.assertFalse(sockets.exists())
        self.assertEqual(list((self.state / "processes").glob("*.json")), [])
        self.assertFalse((self.state / f"{self.identity}.json").exists())

    def test_setup_keeps_own_browser_endpoint_when_main_browser_is_healthy(self):
        (self.main / wt.APP / ".env").write_text("TELOMI_BROWSER_HOST_CDP_URL=http://127.0.0.1:9222\n")
        kernel = self.root / wt.APP / ".prime-kernel"
        kernel.mkdir()
        bootstrap = kernel / ".bootstrap-version"
        bootstrap.write_text("{}")
        with ExitStack() as stack:
            for name in ("checked", "prepare_venv", "prepare_prime", "doctor"):
                stack.enter_context(patch.object(wt, name))
            stack.enter_context(patch.object(wt, "prime_info", return_value={"file": str(bootstrap)}))
            stack.enter_context(patch.object(wt.urllib.request, "urlopen", return_value=io.BytesIO(b'{"webSocketDebuggerUrl":"ws://main-browser"}')))
            wt.setup(self.root)
        metadata = json.loads((self.state / f"{self.identity}.json").read_text())
        env = wt.read_env(self.root)
        self.assertEqual(env["TELOMI_BROWSER_HOST_CDP_URL"], f"http://127.0.0.1:{metadata['ports'][5]}")
        # The agent-browser CLI reads an empty AGENT_BROWSER_CONFIG as a missing file, so the overlay
        # points it at a private config for this Worktree's own Chrome, never the main checkout's 9222.
        config = Path(env["AGENT_BROWSER_CONFIG"])
        self.assertTrue(config.is_relative_to(self.root / wt.APP / "data"))
        self.assertEqual(json.loads(config.read_text()), {"cdp": str(metadata["ports"][5])})
        wt.check_agent_browser_config(env)
        config.write_text('{"cdp": "9222"}')
        with self.assertRaisesRegex(RuntimeError, "rerun worktree setup"):
            wt.check_agent_browser_config(env)
        # An overlay from before this config existed only warns, so running work is not blocked.
        with patch("builtins.print") as printed:
            wt.check_agent_browser_config({**env, "AGENT_BROWSER_CONFIG": ""})
        self.assertIn("rerun worktree setup", printed.call_args.args[0])

    def test_incompatible_shared_environment_detaches_only_link(self):
        source = self.main / wt.HINDSIGHT / ".venv"
        source.mkdir(parents=True)
        (source / "preserve").write_text("donor")
        target = self.root / wt.HINDSIGHT / ".venv"
        target.parent.mkdir(parents=True)
        target.symlink_to(source, target_is_directory=True)
        with patch.object(wt, "compatible_venv", return_value=False), patch.object(wt, "checked") as install:
            wt.prepare_venv(self.root, self.main, self.state, self.identity, wt.HINDSIGHT, "3.11", share=True)
        self.assertFalse(target.is_symlink())
        self.assertEqual((source / "preserve").read_text(), "donor")
        self.assertEqual(install.call_args.args[-1]["UV_PROJECT_ENVIRONMENT"], str(target))

    def test_ports_and_three_run_slots(self):
        ports = wt.unused_ports(8)
        self.assertEqual(len(set(ports)), 8)
        with ExitStack() as stack:
            for slot in range(3):
                stack.enter_context(wt.locked(self.state / f"run-{slot}.lock", wait=False))
            result = self.cli("run", "--", sys.executable, "-c", "print('should not run')")
        self.assertEqual(result.returncode, 1)
        self.assertIn("All 3", result.stderr)
        self.assertNotIn("should not run", result.stdout)

    def test_port_migration_preserves_existing_assignments_and_excludes_siblings(self):
        previous = {"ports": wt.unused_ports(8)}
        wt.save(self.state / f"{self.identity}.json", previous)
        sibling = wt.allocated_ports(self.state, {})
        wt.save(self.state / "sibling.json", {"ports": sibling})
        migrated = wt.allocated_ports(self.state, previous)
        self.assertEqual(migrated[:8], previous["ports"])
        self.assertEqual(len(set(migrated)), 11)
        self.assertFalse(set(migrated) & set(sibling))
        self.assertEqual(wt.allocated_ports(self.state, {"ports": migrated}), migrated)

    def test_port_allocation_skips_udp_only_listener(self):
        with socket.socket() as tcp, socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as udp:
            tcp.bind(("127.0.0.1", 0))
            busy = tcp.getsockname()[1]
            udp.bind(("127.0.0.1", busy))
            tcp.close()
            candidates = iter((busy, 0))

            class CandidateSocket(socket.socket):
                def bind(self, address):
                    if self.type == socket.SOCK_STREAM:
                        address = (address[0], next(candidates))
                    super().bind(address)

            with patch.object(wt.socket, "socket", CandidateSocket):
                ports = wt.unused_ports(1)
            self.assertNotEqual(ports[0], busy)
            self.assertEqual(udp.getsockname()[1], busy)

    def test_main_checkout_launch_and_run_are_managed(self):
        for action in ("run", "launch"):
            result = self.cli(action, "--", sys.executable, "-c", "print('main started')", root=self.main)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("main started", result.stdout)

    def test_interrupted_command_exits_clean_without_hiding_failures(self):
        for body, expected in (("signal.signal(signal.SIGINT, lambda *_: sys.exit(130))", 0),
                               ("signal.signal(signal.SIGINT, signal.SIG_DFL)", 0),
                               ("signal.signal(signal.SIGINT, lambda *_: sys.exit(1))", 1)):
            with self.subTest(body=body):
                child = subprocess.Popen([sys.executable, str(SCRIPT), "--root", str(self.main), "run", "--", sys.executable,
                                          "-c", f"import signal,sys,time; {body}; print('ready', flush=True); time.sleep(30)"],
                                         stdout=subprocess.PIPE, text=True)
                self.assertEqual(child.stdout.readline().strip(), "ready")
                child.send_signal(signal.SIGINT)
                self.assertEqual(child.wait(timeout=30), expected)
        result = self.cli("run", "--", sys.executable, "-c", "import sys; sys.exit(130)", root=self.main)
        self.assertEqual(result.returncode, 130, "an uninterrupted 130 is a real failure")
        result = self.cli("run", "--", sys.executable, "-c", "import os,signal; os.kill(os.getpid(), signal.SIGTERM)", root=self.main)
        self.assertEqual(result.returncode, 143, "signal deaths report 128+signal")

    def test_operations_instance_overrides_persistent_worktree_runtime_values(self):
        overlay = self.root / wt.APP / ".env.worktree"
        overlay.write_text("PORT=21001\nTELOMI_DATA_DIR=/worktree-data\nSECRET=worktree\n")
        with patch.dict(os.environ, {
            "TELOMI_OPERATIONS_EXCHANGE_ROOT": "/eval/exchange",
            "PORT": "22001",
            "TELOMI_DATA_DIR": "/eval/data",
        }):
            env = wt.execution_env(self.root)
        self.assertEqual(env["PORT"], "22001")
        self.assertEqual(env["TELOMI_DATA_DIR"], "/eval/data")
        self.assertEqual(env["SECRET"], "worktree")
        with patch.dict(os.environ, {"PORT": "22001"}):
            self.assertEqual(wt.execution_env(self.root)["PORT"], "21001")

    def test_hook_relative_git_paths_survive_app_cwd(self):
        app = self.root / wt.APP
        git_dir = subprocess.check_output(["git", "-C", str(self.root), "rev-parse", "--absolute-git-dir"], text=True).strip()
        for overrides in ({"GIT_DIR": git_dir}, {"GIT_DIR": git_dir, "GIT_WORK_TREE": "."}):
            with self.subTest(overrides=overrides):
                result = subprocess.run([sys.executable, str(SCRIPT), "--root", str(app), "check", "--",
                                         "git", "rev-parse", "--show-toplevel"], cwd=self.root,
                                        env={**os.environ, **overrides}, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout.strip(), str(self.root))

    def test_checks_preserve_cwd_stdin_exit_and_allow_nested_hook(self):
        app = self.root / wt.APP
        result = subprocess.run([sys.executable, str(SCRIPT), "--root", str(app), "check", "--", sys.executable,
                                 "-c", "import os,sys; print(os.getcwd()); print(sys.stdin.read()); sys.exit(23)"],
                                input="staged paths", text=True, capture_output=True)
        self.assertEqual(result.returncode, 23, result.stderr)
        self.assertIn(str(app), result.stdout)
        self.assertIn("staged paths", result.stdout)
        nested = [sys.executable, str(SCRIPT), "--root", str(app), "check", "--", sys.executable, "-c", "print('nested passed')"]
        result = self.cli("check", "--", *nested)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("nested passed", result.stdout)
        self.assertEqual(list((self.state / "processes").glob("*.json")), [])

    def test_check_serialization_and_stop_owned_process(self):
        events = self.root / "events.txt"
        code = "import pathlib,time; p=pathlib.Path(%r); p.open('a').write('start\\n'); time.sleep(.2); p.open('a').write('end\\n')" % str(events)
        command = [sys.executable, str(SCRIPT), "--root", str(self.root), "check", "--", sys.executable, "-c", code]
        first = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        second = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.addCleanup(lambda: first.poll() is None and first.kill())
        self.addCleanup(lambda: second.poll() is None and second.kill())
        first.communicate(timeout=10)
        second.communicate(timeout=10)
        self.assertEqual((first.returncode, second.returncode), (0, 0))
        self.assertEqual(events.read_text(), "start\nend\nstart\nend\n")
        started = self.root / "started.txt"
        command[-1] = "import pathlib,time; pathlib.Path(%r).touch(); time.sleep(60)" % str(started)
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.addCleanup(lambda: process.poll() is None and process.kill())
        for _ in range(100):
            if started.exists():
                break
            time.sleep(.02)
        self.assertTrue(started.exists())
        self.assertEqual(self.cli("stop").returncode, 0)
        process.communicate(timeout=10)
        self.assertNotEqual(process.returncode, 0)
        self.assertEqual(list((self.state / "processes").glob("*.json")), [])

    def test_nested_siblings_are_serialized(self):
        events = self.root / "events.txt"
        child = "import pathlib,time; p=pathlib.Path(%r); p.open('a').write('start\\n'); time.sleep(.15); p.open('a').write('end\\n')" % str(events)
        command = [sys.executable, str(SCRIPT), "--root", str(self.root), "check", "--", sys.executable, "-c", child]
        outer = "import subprocess; a=subprocess.Popen(%r); b=subprocess.Popen(%r); assert a.wait()==b.wait()==0" % (command, command)
        result = self.cli("check", "--", sys.executable, "-c", outer)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(events.read_text(), "start\nend\nstart\nend\n")

    def test_supervisor_death_does_not_release_active_check(self):
        events = self.root / "events.txt"
        started = self.root / "started.txt"
        child = "import pathlib,time; p=pathlib.Path(%r); p.open('a').write('first-start\\n'); pathlib.Path(%r).touch(); time.sleep(.5); p.open('a').write('first-end\\n')" % (str(events), str(started))
        command = [sys.executable, str(SCRIPT), "--root", str(self.root), "check", "--", sys.executable, "-c", child]
        supervisor = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.addCleanup(lambda: supervisor.poll() is None and supervisor.kill())
        for _ in range(100):
            if started.exists():
                break
            time.sleep(.02)
        self.assertTrue(started.exists())
        supervisor.kill()
        result = self.cli("check", "--", sys.executable, "-c", "import pathlib; pathlib.Path(%r).open('a').write('second\\n')" % str(events))
        supervisor.communicate(timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(events.read_text(), "first-start\nfirst-end\nsecond\n")
        self.assertEqual(self.cli("stop").returncode, 0)

    def test_stop_cancels_queued_check_before_it_can_start(self):
        started = self.root / "active.txt"
        queued_started = self.root / "queued.txt"
        command = [sys.executable, str(SCRIPT), "--root", str(self.root), "check", "--", sys.executable, "-c"]
        first = subprocess.Popen(command + ["import pathlib,time; pathlib.Path(%r).touch(); time.sleep(60)" % str(started)], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.addCleanup(lambda: first.poll() is None and first.kill())
        for _ in range(100):
            if started.exists():
                break
            time.sleep(.02)
        self.assertTrue(started.exists())
        second = subprocess.Popen(command + ["import pathlib; pathlib.Path(%r).touch()" % str(queued_started)], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.addCleanup(lambda: second.poll() is None and second.kill())
        for _ in range(100):
            if len(list((self.state / "waiters").glob("*.json"))) == 2:
                break
            time.sleep(.02)
        self.assertEqual(len(list((self.state / "waiters").glob("*.json"))), 2)
        stopped = self.cli("stop")
        first.communicate(timeout=10)
        second.communicate(timeout=10)
        self.assertEqual(stopped.returncode, 0, stopped.stderr)
        self.assertFalse(queued_started.exists())
        self.assertEqual(list((self.state / "waiters").glob("*.json")), [])

    def test_seed_copies_history_without_writable_links(self):
        source = self.main / wt.APP / "data"
        goal = "goal_historical"
        (source / goal).mkdir(parents=True)
        (source / goal / "log.jsonl").write_text("history\n")
        (source / goal / "linked").symlink_to(source / goal / "log.jsonl")
        (source / "goals.json").write_text(json.dumps([{"id": goal, "title": "Historical Goal"}]))
        overlay = wt.isolation_env(self.root, {}, self.identity, range(21000, 21011))
        wt.write_overlay(self.root, overlay)
        wt.seed(self.root, goal)
        copied = self.root / wt.APP / "data" / goal
        self.assertFalse((copied / "linked").exists())
        (copied / "log.jsonl").write_text("local edit")
        self.assertEqual((source / goal / "log.jsonl").read_text(), "history\n")
        with self.assertRaisesRegex(RuntimeError, "already exists"):
            wt.seed(self.root, goal)
        with self.assertRaisesRegex(RuntimeError, "valid Goal"):
            wt.seed(self.root, "../../escape")

    def test_remove_preserves_dirty_or_unmerged_worktrees(self):
        loose = self.root / "unsaved.txt"
        loose.write_text("preserve")
        self.assertNotEqual(self.cli("remove").returncode, 0)
        self.assertTrue(loose.exists())
        subprocess.run(["git", "-C", str(self.root), "add", "."], check=True)
        subprocess.run(["git", "-C", str(self.root), "commit", "-qm", "unmerged"], check=True)
        self.assertNotEqual(self.cli("remove").returncode, 0)
        self.assertTrue(loose.exists())
        self.assertNotEqual(self.cli("remove", root=self.main).returncode, 0)

    def test_create_defaults_to_dev_and_accepts_main_for_hotfix(self):
        self.git("switch", "dev")
        self.git("commit", "--allow-empty", "-qm", "development")
        for branch, base_args, expected in (("feature/new", [], "dev"), ("hotfix/new", ["--base", "main"], "main")):
            with self.subTest(branch=branch):
                target = self.main.parent / branch
                args = [str(SCRIPT), "--root", str(self.main), "create", str(target), "--branch", branch, *base_args]
                # Exercise the CLI parser and real Git creation without installing dependencies.
                with patch.object(sys, "argv", args), patch.object(wt, "setup") as setup:
                    self.assertEqual(wt.main(), 0)
                setup.assert_called_once_with(target)
                self.assertEqual(self.git("rev-parse", branch), self.git("rev-parse", expected))

    def test_remove_accepts_dev_and_main_merges_and_preserves_branches(self):
        for base in ("dev", "main"):
            with self.subTest(base=base):
                branch = f"merged/{base}"
                target = self.main.parent / branch
                self.git("worktree", "add", "-b", branch, str(target), base)
                subprocess.run(["git", "-C", str(target), "commit", "--allow-empty", "-qm", branch], check=True)
                self.git("switch", base)
                self.git("merge", "--ff-only", branch)
                sockets = Path(f"/tmp/telomi-ab-{wt.context(target)[3]}")
                sockets.mkdir()
                self.addCleanup(shutil.rmtree, sockets, True)
                result = self.cli("remove", root=target)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertFalse(target.exists())
                self.assertFalse(sockets.exists())
                self.assertEqual(self.git("rev-parse", branch), self.git("rev-parse", base))

    def test_remove_preserves_main_and_dev_worktrees(self):
        self.git("switch", "--detach")
        for branch in ("main", "dev"):
            with self.subTest(branch=branch):
                subprocess.run(["git", "-C", str(self.root), "switch", branch], check=True, capture_output=True)
                result = self.cli("remove")
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("Cannot remove a main or dev worktree", result.stderr)
                self.assertTrue(self.root.exists())


if __name__ == "__main__":
    unittest.main()
