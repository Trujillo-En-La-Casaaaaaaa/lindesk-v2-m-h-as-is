import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

records = []


class Handler(BaseHTTPRequestHandler):
    def send_json(self, status, value):
        body = json.dumps(value, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self.send_json(200, {"ok": True})
        elif self.path == "/notifications":
            self.send_json(200, records)
        else:
            self.send_json(404, {"error": "Not found"})

    def do_POST(self):
        if self.path != "/notifications":
            self.send_json(404, {"error": "Not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            message = json.loads(self.rfile.read(length))
            if message.get("type") != "ORDER_CONFIRMATION" or not message.get("orderId"):
                raise ValueError("invalid confirmation")
            record = {"id": f"notification-{len(records) + 1:04d}", **message}
            records.append(record)
            self.send_json(201, record)
        except (ValueError, json.JSONDecodeError):
            self.send_json(400, {"error": "Invalid notification"})

    def log_message(self, format, *args):
        print(format % args, flush=True)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "4010"))
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
