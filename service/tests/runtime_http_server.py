"""Small real-loopback HTTP fixtures for Launcher boundary tests."""

from __future__ import annotations

import socket
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, HTTPServer


@contextmanager
def loopback_http_server(
    *,
    status: int = 200,
    body: bytes = b'<div id="root"></div>',
    content_type: str = "text/html; charset=utf-8",
) -> Iterator[int]:
    """Serve one deterministic response on an ephemeral loopback port."""

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, _format: str, *args: object) -> None:
            return

    server = HTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(
        target=server.serve_forever,
        kwargs={"poll_interval": 0.01},
        daemon=True,
    )
    thread.start()
    try:
        yield int(server.server_address[1])
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=1)


@contextmanager
def connection_refused_loopback_port() -> Iterator[int]:
    """Reserve a port without listening so connections fail deterministically."""

    reservation = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    reservation.bind(("127.0.0.1", 0))
    try:
        yield int(reservation.getsockname()[1])
    finally:
        reservation.close()
