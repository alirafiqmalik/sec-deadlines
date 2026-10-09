"""Build a temporary Jekyll preview for browser tests. No production settings change."""
import subprocess
import tempfile
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

root = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix="venue-preview-") as directory:
    subprocess.run(["ruby", "-e", 'load Gem.bin_path("jekyll", "jekyll")', "--", "build", "--source", str(root), "--destination", directory, "--disable-disk-cache"], check=True, cwd=root)
    # Serve the configured baseurl without changing the production configuration.
    class Handler(SimpleHTTPRequestHandler):
        def translate_path(self, path):
            if path.startswith("/sec-deadlines/"):
                path = path[len("/sec-deadlines"):]
            return super().translate_path(path)
        def log_message(self, *args):
            pass
    ThreadingHTTPServer(("127.0.0.1", 48763), partial(Handler, directory=directory)).serve_forever()
