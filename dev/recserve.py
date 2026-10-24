"""Serves the app from this PC to the phone (through adb reverse, see phone.py) and saves what the live worker records
there: recserve.py <app folder> <port>. Each session goes to dev/videos/rec_<name>/ (ignored by git: it shows John's
real documents, so never commit it): grey.bin (the worker's grey pictures, one after another), ai.bin (the AI's 224 x 224
RGB pictures, for the frames it was asked about), frames.jsonl (one line per frame: what the worker made of it, and where
its pictures are in the two files).

Unlike the app on GitHub Pages it sends the cross-origin isolation headers itself, and has no service worker (sw.js is
not served), so every reload gets the files as they are on disk now."""
import functools, http.server, json, os, struct, sys, threading
from urllib.parse import urlparse, parse_qs

VIDEOS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "videos")
lock = threading.Lock()


class Handler(http.server.SimpleHTTPRequestHandler):
    def send_head(self):
        for h in ("If-Modified-Since", "If-None-Match"):
            if h in self.headers: del self.headers[h]
        if urlparse(self.path).path.endswith("/sw.js"):
            self.send_error(404)
            return None
        return super().send_head()

    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_POST(self):
        u = urlparse(self.path)
        if not u.path.endswith("/rec"):
            self.send_error(404)
            return
        name = "".join(c for c in parse_qs(u.query).get("s", ["session"])[0] if c.isalnum() or c in "-_") or "session"
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        (n,) = struct.unpack_from("<I", body, 0)
        frames = json.loads(body[4:4 + n].decode("utf8"))
        pos = 4 + n
        d = os.path.join(VIDEOS, "rec_" + name)
        with lock:
            os.makedirs(d, exist_ok=True)
            with open(os.path.join(d, "grey.bin"), "ab") as g, open(os.path.join(d, "ai.bin"), "ab") as a, \
                    open(os.path.join(d, "frames.jsonl"), "a", encoding="utf8") as fl:
                for fr in frames:
                    fr["goff"] = g.tell()
                    g.write(body[pos:pos + fr["g"]]); pos += fr["g"]
                    if fr["a"]:
                        fr["aoff"] = a.tell()
                        a.write(body[pos:pos + fr["a"]]); pos += fr["a"]
                    fl.write(json.dumps(fr, separators=(",", ":")) + "\n")
        self.send_response(204)
        self.end_headers()

    def log_message(self, *a):
        pass


folder, port = sys.argv[1], int(sys.argv[2])
print(f"serving {folder} on http://127.0.0.1:{port}/, recordings to {VIDEOS}", flush=True)
http.server.ThreadingHTTPServer(("127.0.0.1", port), functools.partial(Handler, directory=folder)).serve_forever()
