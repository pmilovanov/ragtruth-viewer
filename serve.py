#!/usr/bin/env python3
"""Serve the RAGTruth explorer.

    python3 serve.py              # corpus expected in ./data/
    python3 serve.py --download   # fetch the corpus first if absent

Standard library only. Binds to localhost unless told otherwise.
"""
from __future__ import annotations

import argparse
import gzip
import json
import mimetypes
import sys
import time
import webbrowser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

import rtdata

HERE = Path(__file__).resolve().parent
STATIC = HERE / "static"
DEFAULT_DATA_DIR = HERE / "data"  # gitignored; --download fills it

MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
}


class App:
    """What the request handlers share: the data, plus cached payloads."""

    def __init__(self, dataset: rtdata.Dataset):
        self.ds = dataset
        self.index_raw = dataset.index_json()
        self.index_gz = gzip.compress(self.index_raw, compresslevel=6)


class Handler(BaseHTTPRequestHandler):
    server_version = "RagTruthUI/1.0"

    @property
    def app(self) -> App:
        return self.server.app  # type: ignore[attr-defined]

    # ---- plumbing --------------------------------------------------------

    def log_message(self, fmt, *args):  # noqa: D401 - stdlib signature
        if not getattr(self.server, "quiet", False):
            super().log_message(fmt, *args)

    def _send(self, status: int, body: bytes, ctype: str, *, extra: dict | None = None):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, obj, status: int = 200):
        body = rtdata._dumps(obj)
        extra = {}
        if len(body) > 4096 and "gzip" in self.headers.get("Accept-Encoding", ""):
            body, extra = gzip.compress(body, compresslevel=5), {"Content-Encoding": "gzip"}
        self._send(status, body, MIME[".json"], extra={**extra, "Vary": "Accept-Encoding"})

    def _error(self, status: HTTPStatus, message: str):
        self._json({"error": message}, status)

    # ---- routing ---------------------------------------------------------

    def do_GET(self):  # noqa: N802 - stdlib naming
        url = urlsplit(self.path)
        path = unquote(url.path)
        try:
            if path.startswith("/api/"):
                return self._api(path[len("/api/"):], parse_qs(url.query))
            return self._static(path)
        except BrokenPipeError:
            pass
        except Exception as exc:  # a bug must not kill the server thread silently
            sys.stderr.write(f"error handling {self.path}: {exc!r}\n")
            self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "internal error")

    do_HEAD = do_GET  # noqa: N815

    def _api(self, route: str, query: dict):
        ds = self.app.ds
        if route == "index":
            if "gzip" in self.headers.get("Accept-Encoding", ""):
                return self._send(200, self.app.index_gz, MIME[".json"],
                                  extra={"Content-Encoding": "gzip", "Vary": "Accept-Encoding"})
            return self._send(200, self.app.index_raw, MIME[".json"], extra={"Vary": "Accept-Encoding"})
        kind, _, key = route.partition("/")
        if kind == "response" and key:
            try:
                return self._json(ds.response_detail(key))
            except KeyError:
                return self._error(HTTPStatus.NOT_FOUND, f"no response {key!r}")
        if kind == "source" and key:
            try:
                return self._json(ds.source_detail(key))
            except KeyError:
                return self._error(HTTPStatus.NOT_FOUND, f"no source {key!r}")
        if kind == "search":
            q = (query.get("q") or [""])[0]
            scope = (query.get("scope") or ["response"])[0]
            try:
                rows = ds.search(q, scope)
            except ValueError as exc:
                return self._error(HTTPStatus.BAD_REQUEST, str(exc))
            return self._json({"q": q, "scope": scope, "rows": rows})
        return self._error(HTTPStatus.NOT_FOUND, f"no such endpoint {route!r}")

    def _static(self, path: str):
        rel = path.lstrip("/") or "index.html"
        target = (STATIC / rel).resolve()
        # Refuse anything that escapes the static directory (.., symlinks).
        if not target.is_relative_to(STATIC.resolve()) or not target.is_file():
            return self._error(HTTPStatus.NOT_FOUND, "not found")
        ctype = MIME.get(target.suffix) or mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        self._send(200, target.read_bytes(), ctype)


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, addr, app: App, quiet: bool = False):
        super().__init__(addr, Handler)
        self.app = app
        self.quiet = quiet


def make_server(data_dir: Path, host: str = "127.0.0.1", port: int = 8765, quiet: bool = False) -> Server:
    return Server((host, port), App(rtdata.Dataset.load(data_dir)), quiet=quiet)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data-dir", type=Path, default=DEFAULT_DATA_DIR,
                    help="directory holding response.jsonl and source_info.jsonl (default: %(default)s)")
    ap.add_argument("--download", action="store_true",
                    help="fetch the corpus from GitHub into --data-dir if it is not already there")
    ap.add_argument("--host", default="127.0.0.1", help="interface to bind (default: %(default)s)")
    ap.add_argument("--port", type=int, default=8765, help="port (default: %(default)s)")
    ap.add_argument("--open", action="store_true", help="open the page in a browser once ready")
    ap.add_argument("--quiet", action="store_true", help="do not log requests")
    args = ap.parse_args(argv)

    data_dir = args.data_dir.resolve()
    missing = rtdata.missing_files(data_dir)
    if missing:
        if not args.download:
            sys.stderr.write(
                f"RAGTruth files not found in {data_dir}: {', '.join(missing)}\n"
                f"Re-run with --download to fetch them (~36 MB from GitHub), or point --data-dir\n"
                f"at a directory that already holds response.jsonl and source_info.jsonl.\n")
            return 2
        rtdata.download(data_dir)

    t0 = time.perf_counter()
    try:
        server = make_server(data_dir, args.host, args.port, args.quiet)
    except rtdata.DataError as exc:
        sys.stderr.write(f"{exc}\n")
        return 2
    except OSError as exc:
        sys.stderr.write(f"cannot listen on {args.host}:{args.port}: {exc}\n")
        return 2

    ds = server.app.ds
    url = f"http://{args.host}:{server.server_address[1]}/"
    print(f"loaded {len(ds.responses):,} responses over {len(ds.sources):,} sources "
          f"in {time.perf_counter() - t0:.1f}s")
    print(f"RAGTruth explorer: {url}   (Ctrl-C to stop)")
    if args.open:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print()
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
