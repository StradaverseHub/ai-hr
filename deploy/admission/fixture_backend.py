"""Fictional Linux transport fixture, never installed as an application runtime."""
import argparse
import base64
import hashlib
import http.server
import json
import os
import pathlib
import socket
import time

parser = argparse.ArgumentParser()
parser.add_argument('--data', required=True)
arguments = parser.parse_args()
ROOT = pathlib.Path(arguments.data)
INVOCATION = os.environ['INVOCATION_ID']
while not (ROOT / 'bind').exists():
    time.sleep(0.01)


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *_args):
        pass

    def reply(self, status, body, content='application/json'):
        self.send_response(status)
        self.send_header('Content-Type', content)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('X-Fictional-Invocation', INVOCATION)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == '/health':
            return self.reply(200 if (ROOT / 'ready').exists() else 503, b'{"status":"ok"}\n')
        if self.path == '/who':
            return self.reply(200, json.dumps({'invocation': INVOCATION}).encode())
        if self.path == '/stream':
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.send_header('Transfer-Encoding', 'chunked')
            self.send_header('X-Fictional-Invocation', INVOCATION)
            self.end_headers()
            self.wfile.write(b'7\r\nstarted\r\n')
            self.wfile.flush()
            deadline = time.monotonic() + 20
            while not (ROOT / 'release-stream').exists() and time.monotonic() < deadline:
                time.sleep(0.01)
            self.wfile.write(b'4\r\ndone\r\n0\r\n\r\n')
            self.wfile.flush()
            return
        if self.path == '/upgrade' and self.headers.get('Upgrade', '').lower() == 'websocket':
            key = self.headers.get('Sec-WebSocket-Key', '')
            accept = base64.b64encode(hashlib.sha1((key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest()).decode()
            self.send_response(101)
            self.send_header('Upgrade', 'websocket')
            self.send_header('Connection', 'Upgrade')
            self.send_header('Sec-WebSocket-Accept', accept)
            self.end_headers()
            self.connection.settimeout(5)
            first = self.rfile.read(2)
            if len(first) != 2:
                return
            length = first[1] & 127
            if length > 125 or not first[1] & 128:
                return
            mask, body = self.rfile.read(4), self.rfile.read(length)
            plain = bytes(value ^ mask[index % 4] for index, value in enumerate(body))
            self.wfile.write(bytes([0x81, len(plain)]) + plain)
            self.wfile.flush()
            self.close_connection = True
            return
        self.reply(404, b'{}')

    def do_POST(self):
        length = int(self.headers.get('Content-Length', '0'))
        if not 0 < length <= 3 * 1024 * 1024:
            return self.reply(413, b'{}')
        body = self.rfile.read(length)
        if self.path == '/upload':
            return self.reply(200, json.dumps({'bytes': len(body), 'sha256': hashlib.sha256(body).hexdigest(),
                                             'host': self.headers.get('Host'), 'cookie': self.headers.get('Cookie'),
                                             'forwardedProto': self.headers.get('X-Forwarded-Proto')}).encode())
        value = json.loads(body)
        receipt = {'id': value['id'], 'invocation': INVOCATION}
        fd = os.open(ROOT / 'writes.jsonl', os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
        try:
            os.write(fd, (json.dumps(receipt) + '\n').encode())
        finally:
            os.close(fd)
        if self.path == '/write-drop':
            # The write happened, but its response is lost. The proxy must
            # expose failure and must never replay it to the other worker.
            self.close_connection = True
            self.connection.shutdown(socket.SHUT_RDWR)
            return
        self.reply(200, json.dumps(receipt).encode())


server = http.server.ThreadingHTTPServer(('127.0.0.1', int(os.environ['PORT'])), Handler)
server.serve_forever(poll_interval=0.05)
