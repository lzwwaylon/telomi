import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent

# A short-lived parent starts the watcher in a child that outlives it, as a Telomi that dies
# without stopping the service does. The child records the SIGTERM the watcher sends itself.
ORPHAN = """
import os, subprocess, sys
subprocess.Popen([sys.executable, "-c", '''
import os, signal, sys
sys.path.insert(0, sys.argv[1])
import app
def stopped(*_):
    open(sys.argv[3], "w").close()
    os._exit(0)
signal.signal(signal.SIGTERM, stopped)
app._exit_with_parent(int(sys.argv[2]), 0.05)
''', sys.argv[1], str(os.getpid()), sys.argv[2]], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
"""


class ParentWatchTests(unittest.TestCase):
    def test_service_stops_when_parent_exits(self):
        with tempfile.TemporaryDirectory() as tmp:
            marker = Path(tmp) / "stopped"
            subprocess.run([sys.executable, "-c", ORPHAN, str(HERE), str(marker)], check=True)
            deadline = time.time() + 120
            while time.time() < deadline and not marker.exists():
                time.sleep(0.1)
            self.assertTrue(marker.exists(), "orphaned service kept running after its parent exited")


if __name__ == "__main__":
    unittest.main()
