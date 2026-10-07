"""Serve ORBIT on http://127.0.0.1:8765 with caching disabled, so edits to the JS always load."""
import http.server
import functools
import os


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


if __name__ == "__main__":
    root = os.path.dirname(os.path.abspath(__file__))
    handler = functools.partial(Handler, directory=root)
    print("ORBIT: http://127.0.0.1:8765  (add ?sim=1 for the no-camera simulation)")
    http.server.ThreadingHTTPServer(("127.0.0.1", 8765), handler).serve_forever()
