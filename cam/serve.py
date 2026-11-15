#!/usr/bin/env python3
"""Serve the published goat cam folder for the Cloudflare Tunnel.

Only the files in CAM_PUBLISH_DIR are served, and only on 127.0.0.1, so cloudflared is the only way in.
Adds the headers the goat site needs to read meta.json from another domain, and turns off
caching so visitors get the newest photo. Folder listings are disabled.
"""
import functools
import http.server
import os
import pathlib

PUBLISH_DIR = pathlib.Path(os.environ.get("CAM_PUBLISH_DIR", "/var/www/goat-cam"))
PORT = int(os.environ.get("CAM_WEB_PORT", "8080"))


class CamHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def list_directory(self, path):
        self.send_error(404, "Not found")
        return None

    def do_GET(self):
        if self.path.split("?")[0] not in ("/", "/latest.jpg", "/meta.json"):
            self.send_error(404, "Not found")
            return
        super().do_GET()

    def log_message(self, fmt, *args):
        pass  # no per-request log lines


if __name__ == "__main__":
    PUBLISH_DIR.mkdir(parents=True, exist_ok=True)
    handler = functools.partial(CamHandler, directory=str(PUBLISH_DIR))
    with http.server.ThreadingHTTPServer(("127.0.0.1", PORT), handler) as server:
        server.serve_forever()
