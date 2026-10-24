"""A plain static server for the app's tests: serve.py <folder> <port>. Unlike `python -m http.server` it never answers
"not modified", so a test that swaps one copy of the app for another at the same address (upgrade.py) always gets the
new files, whatever the files' dates."""
import functools, http.server, sys


class Handler(http.server.SimpleHTTPRequestHandler):
    def send_head(self):
        for h in ("If-Modified-Since", "If-None-Match"):
            if h in self.headers: del self.headers[h]
        return super().send_head()

    def log_message(self, *a):
        pass


folder, port = sys.argv[1], int(sys.argv[2])
http.server.ThreadingHTTPServer(("127.0.0.1", port), functools.partial(Handler, directory=folder)).serve_forever()
