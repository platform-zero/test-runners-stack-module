"""Concrete bounded same-origin HTTPS transport for lead-provisioned S2 harnesses.

No CLI, credential loading, environment lookup, redirect following or retries.
Authentication is supplied privately by the integrating harness, not by models.
Instantiation is not a test-target authorization: lead handoff is still required.
"""
import http.client
import json
import ssl
import re
import uuid
from urllib.parse import unquote, urlsplit

from native_workflows import Response, WorkflowError, require


class ScopedHTTPS:
    def __init__(self, origin, *, allowed_prefixes, headers, context=None,
                 connection_factory=http.client.HTTPSConnection, channel_factory=None,
                 max_response_bytes=2 * 1024 * 1024):
        target = urlsplit(origin)
        require(target.scheme == 'https' and bool(target.hostname) and not target.username
                and not target.password and target.path in ('', '/') and not target.query
                and not target.fragment, 'HTTPS origin required without userinfo/path/query')
        require(not any(c in origin for c in '\r\n\x00'), 'invalid HTTPS origin')
        self.host, self.port = target.hostname, target.port or 443
        self.origin = 'https://' + target.netloc
        self.context = context or ssl.create_default_context()
        require(self.context.verify_mode == ssl.CERT_REQUIRED and self.context.check_hostname,
                'verified hostname TLS required')
        require(allowed_prefixes and all(p.startswith('/') and not p.startswith('//') and
                not any(c in p for c in '?%#\\\r\n') for p in allowed_prefixes),
                'explicit canonical API namespace prefixes required')
        require(type(max_response_bytes) is int and 1 <= max_response_bytes <= 8 * 1024 * 1024,
                'bounded response size required')
        self.prefixes = tuple(allowed_prefixes)
        self.headers = headers
        self.connection_factory, self.channel_factory = connection_factory, channel_factory
        self.max_bytes = max_response_bytes

    def _path(self, path):
        require(isinstance(path, str) and path.startswith('/') and not path.startswith('//')
                and not any(c in path for c in '#\\\r\n\x00') and len(path) <= 4096,
                'invalid relative transport path')
        parsed = urlsplit(path)
        require(not parsed.scheme and not parsed.netloc, 'transport origin escape rejected')
        decoded = unquote(parsed.path)
        require(decoded == parsed.path, 'encoded path aliases rejected')
        require(not any(part in ('.', '..') for part in decoded.split('/')) and '%' not in decoded
                and '\\' not in decoded and not decoded.startswith('//')
                and not any(c in decoded for c in '\r\n\x00'), 'noncanonical transport path')
        require(any(decoded == p.rstrip('/') or decoded.startswith(p.rstrip('/') + '/')
                    for p in self.prefixes), 'path outside handed-off API namespace')
        return path

    def _require_tls(self):
        require(self.context.verify_mode == ssl.CERT_REQUIRED and self.context.check_hostname,
                'verified hostname TLS required')

    def _headers(self):
        try:
            headers = self.headers()
            require(isinstance(headers, dict), 'private headers callback must return mapping')
            allowed = {'authorization', 'cookie', 'x-xsrftoken', 'x-csrf-token'}
            require(all(isinstance(k, str) and k.lower() in allowed and isinstance(v, str)
                        and not any(c in v for c in '\r\n\x00') for k, v in headers.items()),
                    'invalid private authentication headers')
            return {**headers, 'Accept': 'application/json', 'Content-Type': 'application/json'}
        except Exception:
            raise WorkflowError('private authentication unavailable (details withheld)') from None

    def request(self, method, path, *, payload=None, timeout, raw_body=None, content_type=None):
        self._require_tls()
        path = self._path(path)
        require(raw_body is None or (payload is None and isinstance(raw_body, bytes)), 'ambiguous/invalid raw request body')
        require(content_type is None or content_type.startswith('multipart/form-data; boundary=')
                and bool(re.fullmatch(r'multipart/form-data; boundary=[a-zA-Z0-9]+', content_type)),
                'unsupported raw content type')
        require(method in ('GET', 'POST', 'PUT', 'PATCH', 'DELETE'), 'unsupported HTTP method')
        require(isinstance(timeout, (float, int)) and 0 < timeout <= 30, 'bounded HTTP timeout required')
        headers = self._headers()
        connection = None
        try:
            body = raw_body if raw_body is not None else (None if payload is None else json.dumps(payload, allow_nan=False).encode())
            if content_type:
                headers['Content-Type'] = content_type
            require(body is None or len(body) <= self.max_bytes, 'request payload size exceeded')
            connection = self.connection_factory(self.host, self.port, timeout=timeout, context=self.context)
            connection.request(method, path, body=body, headers=headers)
            response = connection.getresponse()
            raw = response.read(self.max_bytes + 1)
            require(len(raw) <= self.max_bytes, 'response payload size exceeded')
            # Redirects are returned untouched. Adapters must reject their status;
            # private auth never follows Location to another origin.
            content_type = response.getheader('Content-Type', '').split(';', 1)[0].strip().lower()
            data = json.loads(raw) if raw and content_type in ('application/json', 'application/problem+json') else None
            return Response(response.status, data=data, body=raw)
        except WorkflowError:
            raise
        except Exception:
            raise WorkflowError('HTTPS request failed (details withheld)') from None
        finally:
            headers.clear()
            if connection is not None:
                try:
                    connection.close()
                except Exception:
                    raise WorkflowError('HTTPS connection cleanup failed (details withheld)') from None

    def upload(self, path, *, filename, content, timeout):
        """Seafile single synthetic-file multipart upload; no filesystem access."""
        require(isinstance(filename, str) and bool(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,79}', filename)),
                'safe synthetic upload filename required')
        require(isinstance(content, bytes) and len(content) <= self.max_bytes - 1024, 'bounded synthetic upload bytes required')
        boundary = 's2' + uuid.uuid4().hex
        require(boundary.encode() not in content, 'multipart boundary collision')
        body = (('--' + boundary + '\r\nContent-Disposition: form-data; name="parent_dir"\r\n\r\n/\r\n'
                 '--' + boundary + '\r\nContent-Disposition: form-data; name="replace"\r\n\r\n0\r\n'
                 '--' + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="' + filename + '"\r\n'
                 'Content-Type: application/octet-stream\r\n\r\n').encode()
                + content + ('\r\n--' + boundary + '--\r\n').encode())
        return self.request('POST', path, timeout=timeout, raw_body=body,
                            content_type='multipart/form-data; boundary=' + boundary)

    def channels(self, path, *, timeout):
        self._require_tls()
        path = self._path(path)
        require(self.channel_factory is not None, 'authenticated native WebSocket factory required')
        require(isinstance(timeout, (float, int)) and 0 < timeout <= 30, 'bounded channel timeout required')
        # Factory is owner-provided and must preserve TLS/origin, message limits,
        # JSON v5 channel framing, XSRF/session handling and bounded receive calls.
        # It owns any private auth internally: this adapter never exposes headers.
        try:
            return self.channel_factory(self.origin, path, timeout=timeout)
        except Exception:
            raise WorkflowError('native channel connection failed (details withheld)') from None
