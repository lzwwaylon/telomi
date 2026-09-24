import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


class RunBootstrapTests(unittest.TestCase):
    def test_bootstrap_only_reuses_an_explicit_environment_without_starting_server(self):
        server_root = Path(__file__).resolve().parent
        venv_root = Path(sys.executable).parent.parent
        env = {
            **os.environ,
            "TELOMI_AUDIO_VENV_PATH": str(venv_root),
            "TELOMI_AUDIO_ASR_AUTO_DOWNLOAD": "false",
            "TELOMI_AUDIO_TTS_AUTO_DOWNLOAD": "false",
            "TELOMI_AUDIO_VAD_AUTO_DOWNLOAD": "false",
        }

        result = subprocess.run(
            [str(server_root / "run.sh"), "--bootstrap-only"],
            cwd=server_root,
            env=env,
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("bootstrap complete", result.stdout.lower())

    def test_bootstrap_creates_a_project_local_uv_environment(self):
        uv = shutil.which("uv")
        if uv is None:
            self.skipTest("uv is required for the managed environment bootstrap")
        server_root = Path(__file__).resolve().parent
        with tempfile.TemporaryDirectory() as temporary_root:
            isolated_server = Path(temporary_root) / "server"
            isolated_server.mkdir()
            shutil.copy2(server_root / "run.sh", isolated_server / "run.sh")
            (isolated_server / "pyproject.toml").write_text(
                "[project]\n"
                'name = "audio-bootstrap-test"\n'
                'version = "0.0.0"\n'
                'requires-python = "==3.12.*"\n'
                "dependencies = []\n\n"
                "[tool.uv]\n"
                "package = false\n",
                encoding="utf-8",
            )
            subprocess.run(
                [uv, "lock", "--project", str(isolated_server), "--python", "3.12"],
                check=True,
                capture_output=True,
                text=True,
                timeout=20,
            )
            env = {
                **os.environ,
                "TELOMI_AUDIO_ASR_AUTO_DOWNLOAD": "false",
                "TELOMI_AUDIO_TTS_AUTO_DOWNLOAD": "false",
                "TELOMI_AUDIO_VAD_AUTO_DOWNLOAD": "false",
            }
            env.pop("TELOMI_AUDIO_VENV_PATH", None)
            result = subprocess.run(
                [str(isolated_server / "run.sh"), "--bootstrap-only"],
                cwd=isolated_server,
                env=env,
                capture_output=True,
                text=True,
                timeout=30,
                check=False,
            )
            managed_python = isolated_server / ".venv" / "bin" / "python"
            python_result = subprocess.run(
                [str(managed_python), "-c", "import sys; print(sys.version_info[:2])"],
                capture_output=True,
                text=True,
                timeout=5,
                check=False,
            )
            pyvenv_config = (isolated_server / ".venv" / "pyvenv.cfg").read_text("utf-8")

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(python_result.returncode, 0, python_result.stderr)
        self.assertEqual(python_result.stdout.strip(), "(3, 12)")
        self.assertIn("uv =", pyvenv_config)


if __name__ == "__main__":
    unittest.main()
