#!/usr/bin/env python3
"""Local classifier endpoint for agentsocks, backed by fastino/GLiNER2.5-Decide.

    python3 contrib/gliner2_server.py [port]        (default 8765, listens on 127.0.0.1 only)

POST /classify  {"text": "...", "labels": ["...", "..."]}  ->  {"label": "...", "confidence": 0.97}
GET  /health                                                ->  {"ok": true}

The model loads once at start-up; requests are served one at a time. Set GLINER2_THREADS to cap
the CPU threads torch uses.
"""
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MAX_BODY = 64 * 1024
MAX_TEXT = 20_000
MAX_LABELS = 16
MAX_LABEL = 200
MODEL = "fastino/GLiNER2.5-Decide"

lock = threading.Lock()
model = None


def load_model():
    import torch
    from gliner2 import AutoExtractor

    threads = os.environ.get("GLINER2_THREADS")
    if threads:
        torch.set_num_threads(int(threads))
    return AutoExtractor.from_pretrained(MODEL)


def classify(text, labels):
    with lock:
        out = model.classify_text(text, {"delivery": labels}, include_confidence=True)["delivery"]
    if isinstance(out, dict):
        return {"label": out["label"], "confidence": float(out["confidence"])}
    return {"label": out, "confidence": 1.0}


class Handler(BaseHTTPRequestHandler):
    def reply(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self.reply(200, {"ok": True, "model": MODEL})
        else:
            self.reply(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/classify":
            return self.reply(404, {"error": "not found"})
        try:
            length = int(self.headers.get("content-length", "0"))
        except ValueError:
            return self.reply(400, {"error": "bad content-length"})
        if length <= 0 or length > MAX_BODY:
            return self.reply(400, {"error": "body must be 1 byte to 64 KiB"})
        try:
            req = json.loads(self.rfile.read(length))
            text, labels = req["text"], req["labels"]
        except (ValueError, KeyError, TypeError):
            return self.reply(400, {"error": "expected JSON with text and labels"})
        valid = (
            isinstance(text, str)
            and 0 < len(text) <= MAX_TEXT
            and isinstance(labels, list)
            and 2 <= len(labels) <= MAX_LABELS
            and all(isinstance(label, str) and 0 < len(label) <= MAX_LABEL for label in labels)
        )
        if not valid:
            return self.reply(400, {"error": "text must be a string and labels a list of 2 to 16 strings"})
        try:
            self.reply(200, classify(text, labels))
        except Exception as err:
            self.reply(500, {"error": type(err).__name__})

    def log_message(self, fmt, *args):
        pass


def main():
    global model
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    model = load_model()
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"gliner2 classifier ready on 127.0.0.1:{port}", file=sys.stderr, flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
