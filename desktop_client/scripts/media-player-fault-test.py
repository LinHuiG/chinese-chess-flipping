"""Exercise the actual Rust Player with a failed HTTP range, then recover.

Requires the bundled runtime directory in MPV_DLL_DIR and a local 120-second
MP4 (MEDIA_FIXTURE, default seek-stress.mp4). Runs a Rust test with null outputs;
no CyberRoom app, user process, audio device or remote source is opened.
"""
import argparse
import http.server
import json
import os
import pathlib
import re
import subprocess
import tempfile
import threading
import time

ROOT = pathlib.Path(__file__).resolve().parents[2]
FILE = pathlib.Path(os.environ.get("MEDIA_FIXTURE", ROOT / "server/target/watch-fixtures/seek-stress.mp4"))
SIZE = FILE.stat().st_size
runtime = pathlib.Path(os.environ.get("MPV_DLL_DIR", ROOT / "server/target/msys-media-review/dlls"))
assert (runtime / "libmpv-2.dll").is_file()
assert SIZE > 8 * 1024 * 1024, "use the 120-second seek-stress fixture so the target is not already cached"
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--scenario", choices=("fault", "continuous", "paused", "eof"), default="fault")
parser.add_argument("--fault-delay", type=float, default=0, help="seconds before the injected HTTP 503")
options = parser.parse_args()


class Handler(http.server.BaseHTTPRequestHandler):
    failed = False
    lock = threading.Lock()

    def log_message(self, *args):
        pass

    def do_GET(self):
        match = re.match(r"bytes=(\d+)-(\d*)", self.headers.get("Range", ""))
        start = int(match[1]) if match else 0
        end = min(int(match[2]) if match and match[2] else SIZE - 1, SIZE - 1)
        with self.lock:
            fail = options.scenario == "fault" and not Handler.failed and SIZE * .35 < start < SIZE * .90
            if fail:
                Handler.failed = True
        if fail:
            time.sleep(options.fault_delay)
            self.send_response(503)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        self.send_response(206 if match else 200)
        self.send_header("Content-Type", "video/mp4")
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Connection", "close")
        if match:
            self.send_header("Content-Range", f"bytes {start}-{end}/{SIZE}")
        self.end_headers()
        try:
            with FILE.open("rb") as stream:
                stream.seek(start)
                left = end - start + 1
                while left:
                    chunk = stream.read(min(32768, left))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    self.wfile.flush()
                    left -= len(chunk)
                    time.sleep(.03)
        except (ConnectionError, OSError):
            pass


server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
try:
    with tempfile.TemporaryDirectory(prefix="cyber-player-fault-") as directory:
        input_path = pathlib.Path(directory) / "input.json"
        data = {"url": f"http://127.0.0.1:{server.server_port}/movie.mp4", "targets": [80]}
        if options.scenario == "fault":
            data["expectReadFailure"] = True
        elif options.scenario == "continuous":
            data.update(targets=[108, 20, 75, 35, 95, 55] * 9 + [40], intervalMs=190, rate=2)
        elif options.scenario == "paused":
            data.update(targets=[80, 10, 60], playing=False)
        else:
            data.update(targets=[119.95], expectEnded=True)
        input_path.write_text(json.dumps(data), encoding="utf8")
        env = dict(os.environ, MPV_DLL_DIR=str(runtime.resolve()), MEDIA_PLAYER_INPUT=str(input_path), MEDIA_PLAYER_TRACE="1")
        result = subprocess.run(["cargo", "test", "--locked", "--manifest-path", "desktop_client/Cargo.toml", "actual_player_network_seek_diagnostics", "--", "--ignored", "--nocapture"], cwd=ROOT, env=env, timeout=130)
        raise SystemExit(result.returncode)
finally:
    server.shutdown()
    server.server_close()
