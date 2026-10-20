"""Authenticated Jupyter JSON WSS via websocket-client; no handwritten WS protocol.

Bind Factory to lead-approved HTTPS origin/user, private auth callback and public
CA PEM; inject as ScopedHTTPS(channel_factory=factory). No credentials in argv,
environment, files or logs. Each channel has one disposable Python worker so
library cookie jars/logging are isolated and whole-operation deadlines can kill
stalled DNS/TLS/handshake/fragment reads. Not a deployment/privilege framework.

IMPORTANT: websocket-client 1.7/1.8 has NO pre-allocation frame/message cap. The
1MiB accepted-message cap below is AFTER library recv; retain external MemoryMax
and RuntimeMaxSec. Do not claim this as a hostile-frame memory bound.
"""
import json
import math
import os
import re
import selectors
import ssl
import subprocess
import sys
import time
from urllib.parse import urlsplit

MAX_MESSAGE = 1024 * 1024
MAX_RPC = 2 * 1024 * 1024
INBOUND_PREALLOCATION_BOUND = False


class ChannelError(RuntimeError):
    pass


def check(value, message):
    if not value:
        raise ChannelError(message)


def seconds(value):
    check(type(value) in (float, int) and math.isfinite(value) and 0 < value <= 30, 'finite channel timeout required (0,30]')
    return value


def encoded(value, limit):
    try:
        data = json.dumps(value, allow_nan=False, separators=(',', ':')).encode('utf8')
        check(len(data) <= limit, 'channel payload exceeds accepted-message limit')
        return data
    except ChannelError:
        raise
    except Exception:
        raise ChannelError('invalid channel JSON (details withheld)') from None


def decode(data):
    def no_constant(_):
        raise ValueError('nonfinite JSON')
    def unique(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError('duplicate JSON key')
            result[key] = value
        return result
    return json.loads(data, parse_constant=no_constant, object_pairs_hook=unique)


def tls_context(ca_pem):
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.load_verify_locations(cadata=ca_pem)
    return context


class _Core:
    """Worker-side supported library API calls, injectable for ordinary unit tests."""
    def __init__(self, client_factory, context_factory=tls_context):
        self.client_factory, self.context_factory = client_factory, context_factory
        self.ws = None

    def connect(self, data, timeout):
        check(self.ws is None, 'channel reconnect is forbidden')
        context = self.context_factory(data['ca_pem'])
        check(context.verify_mode == ssl.CERT_REQUIRED and context.check_hostname and not context.keylog_filename,
              'verified TLS context without key logging required')
        self.ws = self.client_factory(sslopt={'context': context, 'cert_reqs': ssl.CERT_REQUIRED,
                                             'check_hostname': True}, enable_multithread=False,
                                      skip_utf8_validation=False)
        self.ws.settimeout(seconds(timeout))
        host = urlsplit(data['url']).hostname
        # Explicit bypass list + explicit proxy host prevent inherited proxy env
        # selection in websocket-client 1.7/1.8's supported proxy_info path.
        self.ws.connect(data['url'], header=data['headers'], origin=data['origin'],
                        timeout=timeout, redirect_limit=0, http_proxy_host=host,
                        http_no_proxy=['*'], subprotocols=None)
        check(self.ws.getstatus() == 101 and self.ws.getsubprotocol() is None
              and not (self.ws.getheaders() or {}).get('sec-websocket-protocol'),
              'WSS upgrade/subprotocol rejected; redirects never pass')
        return None

    def send(self, value, timeout):
        check(self.ws is not None, 'channel not connected')
        text = encoded(value, MAX_MESSAGE).decode('utf8')
        self.ws.settimeout(seconds(timeout))
        self.ws.send(text)  # supported default TEXT framing/masking by library
        return None

    def receive(self, timeout):
        check(self.ws is not None, 'channel not connected')
        self.ws.settimeout(seconds(timeout))
        value = self.ws.recv()  # library owns handshake, ping/pong and fragmentation
        check(isinstance(value, str) and len(value) <= MAX_MESSAGE
              and len(value.encode('utf8')) <= MAX_MESSAGE, 'binary/oversize/closed Jupyter JSON channel')
        value = decode(value)
        check(isinstance(value, dict) and isinstance(value.get('header'), dict)
              and isinstance(value.get('parent_header'), dict) and isinstance(value.get('content'), dict)
              and value.get('channel') in ('shell', 'iopub', 'stdin', 'control'), 'invalid Jupyter JSON envelope')
        return value

    def close(self):
        if self.ws is not None:
            self.ws.shutdown()  # immediate supported socket cleanup, no unbounded close-frame recv
            self.ws = None


def _serve():
    # Dedicated process ONLY: do not mutate parent/provider/model/log configuration.
    import logging
    import websocket
    websocket.enableTrace(False)
    logging.getLogger('websocket').disabled = True
    core = _Core(websocket.WebSocket)
    try:
        while True:
            line = sys.stdin.buffer.readline(MAX_RPC + 2)
            if not line:
                break
            check(len(line) <= MAX_RPC + 1 and line.endswith(b'\n'), 'worker request size rejected')
            try:
                request = decode(line)
                op, value, timeout = request['op'], request.get('value'), request['timeout']
                seconds(timeout)
                if op == 'connect':
                    result = core.connect(value, timeout)
                elif op == 'send':
                    result = core.send(value, timeout)
                elif op == 'receive':
                    result = core.receive(timeout)
                elif op == 'close':
                    core.close()
                    result = None
                else:
                    raise ChannelError('unknown worker operation')
                reply = encoded({'ok': True, 'value': result}, MAX_RPC)
            except Exception:
                reply = b'{"ok":false}'  # no library exceptions/headers/URLs/body dumps
            sys.stdout.buffer.write(reply + b'\n')
            sys.stdout.buffer.flush()
            if request.get('op') == 'close':
                break
    finally:
        core.close()


class _ProcessRPC:
    """Private bounded stdin/stdout JSON IPC, NOT a WebSocket implementation."""
    def __init__(self):
        self.process = subprocess.Popen([sys.executable, '-I', '-B', os.path.abspath(__file__), '--worker'],
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                        close_fds=True, env={'LC_ALL': 'C'})
        os.set_blocking(self.process.stdin.fileno(), False)
        os.set_blocking(self.process.stdout.fileno(), False)
        self.closed = False

    def request(self, op, value, timeout):
        check(not self.closed, 'channel worker closed')
        deadline = time.monotonic() + seconds(timeout)
        data = encoded({'op': op, 'value': value, 'timeout': timeout}, MAX_RPC) + b'\n'
        received = bytearray()
        try:
            with selectors.DefaultSelector() as selector:
                selector.register(self.process.stdin, selectors.EVENT_WRITE)
                selector.register(self.process.stdout, selectors.EVENT_READ)
                while True:
                    left = deadline - time.monotonic()
                    check(left > 0, 'channel operation deadline exceeded')
                    events = selector.select(left)
                    check(events, 'channel operation deadline exceeded')
                    for key, _ in events:
                        if key.fileobj is self.process.stdin:
                            count = os.write(key.fd, data[:16384])
                            data = data[count:]
                            if not data:
                                selector.unregister(self.process.stdin)
                        else:
                            part = os.read(key.fd, min(16384, MAX_RPC + 1 - len(received)))
                            check(part, 'channel worker exited')
                            received.extend(part)
                            check(len(received) <= MAX_RPC, 'channel worker response exceeds limit')
                            if b'\n' in received:
                                check(received.endswith(b'\n') and received.count(b'\n') == 1, 'invalid worker response framing')
                                reply = decode(received)
                                check(reply.get('ok') is True, 'native channel operation failed (details withheld)')
                                return reply.get('value')
        except Exception:
            self.abort()
            raise ChannelError('native channel operation failed/deadline exceeded (details withheld)') from None

    def abort(self):
        if self.closed:
            return
        self.closed = True
        try:
            if self.process.poll() is None:
                self.process.kill()  # exact owned worker only; never host/container lifecycle
            self.process.wait(timeout=1)
        except Exception:
            raise ChannelError('owned channel worker cleanup incomplete') from None
        finally:
            self.process.stdin.close()
            self.process.stdout.close()


class NativeChannel:
    def __init__(self, rpc, send_timeout):
        self.rpc, self.send_timeout, self.closed = rpc, send_timeout, False

    def _request(self, op, value, timeout):
        try:
            return self.rpc.request(op, value, timeout)
        except Exception:
            self.closed = True
            self.rpc.abort()
            raise ChannelError('native channel operation failed (details withheld)') from None

    def send(self, message):
        check(not self.closed and isinstance(message, dict), 'channel closed or invalid outgoing message')
        encoded(message, MAX_MESSAGE)
        self._request('send', message, self.send_timeout)

    def receive(self, timeout):
        check(not self.closed, 'channel closed')
        return self._request('receive', None, seconds(timeout))

    def close(self):
        if self.closed:
            return
        self.closed = True
        try:
            self.rpc.request('close', None, 2)
        except Exception:
            raise ChannelError('native channel cleanup failed (details withheld)') from None
        finally:
            self.rpc.abort()


class NativeChannelFactory:
    def __init__(self, origin, *, user, auth_headers, ca_pem, send_timeout=10, rpc_factory=_ProcessRPC):
        target = urlsplit(origin)
        check(target.scheme == 'https' and target.hostname and not target.username and not target.password
              and target.path in ('', '/') and not target.query and not target.fragment
              and not any(c in origin for c in '\r\n\x00'), 'canonical approved HTTPS origin required')
        check(isinstance(user, str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,79}', user), 'approved isolated user required')
        check(isinstance(ca_pem, str) and 1 <= len(ca_pem.encode()) <= 256 * 1024
              and 'PRIVATE KEY' not in ca_pem, 'public CA PEM required, never private keys')
        self.origin = 'https://' + target.netloc
        self.user, self.auth_headers, self.ca_pem = user, auth_headers, ca_pem
        self.send_timeout, self.rpc_factory = seconds(send_timeout), rpc_factory

    def __call__(self, origin, path, *, timeout):
        check(origin.rstrip('/') == self.origin, 'channel origin differs from approved target')
        check(isinstance(path, str) and re.fullmatch('/user/' + re.escape(self.user)
              + r'/api/kernels/[A-Za-z0-9][A-Za-z0-9_.-]{0,79}/channels', path), 'noncanonical or cross-user kernel channel path')
        seconds(timeout)
        rpc = None
        headers = {}
        try:
            supplied = self.auth_headers()
            allowed = {'authorization', 'cookie', 'x-xsrftoken', 'x-csrf-token'}
            check(isinstance(supplied, dict) and supplied, 'private scoped channel authentication required')
            check(all(isinstance(k, str) and k.lower() in allowed and isinstance(v, str)
                      and not any(c in v for c in '\r\n\x00') for k, v in supplied.items()), 'invalid private channel headers')
            check(sum(len(k.encode()) + len(v.encode()) for k, v in supplied.items()) <= 16384, 'private channel headers exceed limit')
            headers.update(supplied)
            rpc = self.rpc_factory()
            rpc.request('connect', {'url': 'wss://' + urlsplit(self.origin).netloc + path,
                                    'origin': self.origin, 'headers': headers, 'ca_pem': self.ca_pem}, timeout)
            return NativeChannel(rpc, self.send_timeout)
        except Exception:
            if rpc is not None:
                rpc.abort()
            raise ChannelError('authenticated channel connection failed (details withheld)') from None
        finally:
            headers.clear()


if __name__ == '__main__':
    if sys.argv[1:] != ['--worker']:
        raise SystemExit('Import NativeChannelFactory; no endpoint/authentication CLI is provided.')
    try:
        _serve()
    except Exception:
        raise SystemExit(1) from None
