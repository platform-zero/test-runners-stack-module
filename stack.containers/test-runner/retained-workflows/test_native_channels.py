"""Fake-library/transport controls only; no endpoint, auth file or native kernel."""
import copy
import json
import ssl
import unittest
from unittest import mock

import native_channels as n

ORIGIN = 'https://jupyter.example.invalid'
PATH = '/user/synthetic/api/kernels/kernel1/channels'
ENVELOPE = {'header': {'msg_type': 'status'}, 'parent_header': {'msg_id': 'generic'},
            'content': {'execution_state': 'idle'}, 'channel': 'iopub'}


class Client:
    def __init__(self, **kwargs):
        self.options, self.calls, self.closed = kwargs, [], False
        self.status, self.protocol, self.value = 101, None, json.dumps(ENVELOPE)

    def settimeout(self, timeout):
        self.calls.append(('timeout', timeout))

    def connect(self, url, **kwargs):
        self.calls.append(('connect', url, copy.deepcopy(kwargs)))

    def getstatus(self):
        return self.status

    def getsubprotocol(self):
        return self.protocol

    def getheaders(self):
        return {}

    def send(self, text):
        self.calls.append(('send', text))
        return len(text)

    def recv(self):
        return self.value

    def shutdown(self):
        self.closed = True


class RPC:
    def __init__(self):
        self.calls, self.aborted, self.fail = [], False, None

    def request(self, op, value, timeout):
        self.calls.append((op, copy.deepcopy(value), timeout))
        if self.fail == op:
            raise RuntimeError('PRIVATE TEST DETAIL')
        return copy.deepcopy(ENVELOPE) if op == 'receive' else None

    def abort(self):
        self.aborted = True


def factory(rpc, **kwargs):
    return n.NativeChannelFactory(ORIGIN, user='synthetic', auth_headers=lambda: {'Authorization': 'generic-fixture'},
                                  ca_pem='generic-public-CA-fixture', rpc_factory=lambda: rpc, **kwargs)


def core():
    client = Client()
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)  # fake connection: no CA/endpoint use
    value = n._Core(lambda **options: (setattr(client, 'options', options) or client),
                    context_factory=lambda ca: context)
    value.connect({'url': 'wss://jupyter.example.invalid' + PATH, 'origin': ORIGIN,
                   'headers': {'Authorization': 'generic-fixture'}, 'ca_pem': 'generic-test-ca'}, 2)
    return value, client, context


class NativeFactoryTests(unittest.TestCase):
    def test_worker_does_not_inherit_parent_credentials_or_proxy_environment(self):
        # No real process, auth input, endpoint or environment contents observed.
        with mock.patch.dict(n.os.environ, {'SYNTHETIC_PRIVATE_TOKEN': 'unit-only',
                                           'HTTPS_PROXY': 'unit-only'}, clear=True), \
                mock.patch.object(n.subprocess, 'Popen') as launch, \
                mock.patch.object(n.os, 'set_blocking'):
            rpc = n._ProcessRPC()
            self.assertEqual(launch.call_args.kwargs['env'], {'LC_ALL': 'C'})
            self.assertTrue(launch.call_args.kwargs['close_fds'])
            rpc.abort()

    def test_connection_send_receive_and_idempotent_owned_close(self):
        rpc = RPC()
        channel = factory(rpc)(ORIGIN, PATH, timeout=3)
        self.assertEqual(rpc.calls[0][0], 'connect')
        self.assertEqual(rpc.calls[0][1]['url'], 'wss://jupyter.example.invalid' + PATH)
        channel.send(ENVELOPE)
        self.assertEqual(channel.receive(2), ENVELOPE)
        channel.close(); channel.close()
        self.assertEqual([c[0] for c in rpc.calls], ['connect', 'send', 'receive', 'close'])
        self.assertTrue(rpc.aborted)

    def test_wrong_origin_user_url_queries_and_path_aliases_before_auth(self):
        rpc = RPC(); auth = mock.Mock(side_effect=AssertionError('must not read auth'))
        f = factory(rpc); f.auth_headers = auth
        for origin, path in [(ORIGIN, PATH.replace('/synthetic/', '/other/')), ('https://foreign.invalid', PATH),
                             (ORIGIN, 'wss://jupyter.example.invalid' + PATH), (ORIGIN, PATH + '?token=generic'),
                             (ORIGIN, PATH.replace('kernel1', '%6bernel1')), (ORIGIN, '/user/synthetic/../other/channels')]:
            with self.subTest(path=path):
                with self.assertRaises(n.ChannelError):
                    f(origin, path, timeout=2)
        auth.assert_not_called(); self.assertFalse(rpc.calls)

    def test_plaintext_userinfo_and_private_key_inputs_refused(self):
        for origin in ['http://jupyter.example.invalid', 'https://user@host.invalid', ORIGIN + '/path']:
            with self.assertRaises(n.ChannelError):
                n.NativeChannelFactory(origin, user='synthetic', auth_headers=lambda: {}, ca_pem='generic')
        with self.assertRaises(n.ChannelError):
            n.NativeChannelFactory(ORIGIN, user='synthetic', auth_headers=lambda: {}, ca_pem='PRIVATE KEY')

    def test_invalid_private_headers_or_callback_never_start_worker(self):
        for supplied in [{}, {'Host': 'foreign.invalid'}, {'Cookie': 'generic\nheader'}, {'Authorization': 'x'*16385}]:
            rpc = RPC(); f = factory(rpc); launcher = mock.Mock(return_value=rpc)
            f.rpc_factory = launcher; f.auth_headers = lambda: supplied
            with self.assertRaises(n.ChannelError):
                f(ORIGIN, PATH, timeout=2)
            launcher.assert_not_called()
        f = factory(RPC())
        f.auth_headers = mock.Mock(side_effect=RuntimeError('PRIVATE TEST DETAIL'))
        with self.assertRaises(n.ChannelError) as caught:
            f(ORIGIN, PATH, timeout=2)
        self.assertNotIn('PRIVATE', str(caught.exception))

    def test_handshake_failure_aborts_owned_worker_and_redacts(self):
        rpc = RPC(); rpc.fail = 'connect'
        with self.assertRaises(n.ChannelError) as caught:
            factory(rpc)(ORIGIN, PATH, timeout=2)
        self.assertTrue(rpc.aborted); self.assertNotIn('PRIVATE', str(caught.exception))

    def test_finite_timeouts_and_outbound_message_limit(self):
        for timeout in [None, 0, -1, float('inf'), float('nan'), 31, True]:
            with self.assertRaises(n.ChannelError):
                n.seconds(timeout)
        rpc = RPC(); channel = factory(rpc)(ORIGIN, PATH, timeout=2)
        with self.assertRaises(n.ChannelError):
            channel.send({'data': 'x' * n.MAX_MESSAGE})
        self.assertEqual(len(rpc.calls), 1)
        channel.close()
        with self.assertRaises(n.ChannelError):
            channel.receive(1)

    def test_send_receive_errors_abort_and_never_expose_library_exception(self):
        for op in ('send', 'receive'):
            rpc = RPC(); channel = factory(rpc)(ORIGIN, PATH, timeout=2); rpc.fail = op
            with self.assertRaises(n.ChannelError) as caught:
                channel.send(ENVELOPE) if op == 'send' else channel.receive(2)
            self.assertTrue(rpc.aborted); self.assertTrue(channel.closed)
            self.assertNotIn('PRIVATE', str(caught.exception))

    def test_close_failure_still_aborts_owned_worker(self):
        rpc = RPC(); channel = factory(rpc)(ORIGIN, PATH, timeout=2); rpc.fail = 'close'
        with self.assertRaises(n.ChannelError):
            channel.close()
        self.assertTrue(rpc.aborted)


class ClientAPITests(unittest.TestCase):
    def test_supported_client_tls_redirect_proxy_and_json_configuration(self):
        value, client, context = core()
        self.assertIs(client.options['sslopt']['context'], context)
        self.assertEqual(client.options['sslopt']['cert_reqs'], ssl.CERT_REQUIRED)
        self.assertTrue(client.options['sslopt']['check_hostname'])
        connect = next(c for c in client.calls if c[0] == 'connect')
        self.assertEqual(connect[2]['redirect_limit'], 0)
        self.assertEqual(connect[2]['http_no_proxy'], ['*'])
        self.assertEqual(connect[2]['http_proxy_host'], 'jupyter.example.invalid')
        self.assertEqual(connect[2]['origin'], ORIGIN)
        self.assertIsNone(connect[2]['subprotocols'])
        value.send(ENVELOPE, 2)
        self.assertEqual(json.loads(client.calls[-1][1]), ENVELOPE)
        self.assertEqual(value.receive(2), ENVELOPE)
        value.close(); value.close(); self.assertTrue(client.closed)

    def test_non101_redirect_and_unexpected_subprotocol_fail(self):
        for status, protocol in [(302, None), (401, None), (101, 'v1.kernel.websocket.jupyter.org')]:
            client = Client(); client.status, client.protocol = status, protocol
            value = n._Core(lambda **kw: client, lambda _: ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT))
            with self.assertRaises(n.ChannelError):
                value.connect({'url': 'wss://jupyter.example.invalid' + PATH, 'origin': ORIGIN,
                               'headers': {}, 'ca_pem': 'generic'}, 2)
            value.close(); self.assertTrue(client.closed)

    def test_binary_oversize_invalid_and_duplicate_json_rejected(self):
        value, client, _ = core()
        for payload in [b'binary', '', 'x'*(n.MAX_MESSAGE+1), 'notjson', '[]',
                        '{"channel":"iopub","channel":"shell"}', '{"value":NaN}']:
            with self.subTest(size=len(payload)):
                client.value = payload
                with self.assertRaises(Exception):
                    value.receive(2)
        value.close()

    def test_unverified_tls_context_refused(self):
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        context.check_hostname = False; context.verify_mode = ssl.CERT_NONE
        value = n._Core(mock.Mock(), lambda _: context)
        with self.assertRaises(n.ChannelError):
            value.connect({'ca_pem': 'generic'}, 2)

    def test_reconnect_is_not_a_retry_policy(self):
        value, client, _ = core()
        with self.assertRaises(n.ChannelError):
            value.connect({'ca_pem': 'generic'}, 2)
        value.close()

    def test_no_preallocation_frame_limit_claimed(self):
        self.assertIs(n.INBOUND_PREALLOCATION_BOUND, False)


class ProcessDeadlineTests(unittest.TestCase):
    def test_local_ipc_success_invalid_reply_and_cleanup(self):
        import subprocess
        import sys
        import os
        for response in ['{"ok":true,"value":{"generic":42}}', 'not-json']:
            worker = 'import sys\nfor line in sys.stdin: print(' + repr(response) + ', flush=True)\n'
            process = subprocess.Popen([sys.executable, '-I', '-B', '-c', worker],
                                       stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            rpc = n._ProcessRPC.__new__(n._ProcessRPC)
            rpc.process, rpc.closed = process, False
            os.set_blocking(process.stdin.fileno(), False); os.set_blocking(process.stdout.fileno(), False)
            try:
                if response == 'not-json':
                    with self.assertRaises(n.ChannelError):
                        rpc.request('receive', None, 2)
                else:
                    self.assertEqual(rpc.request('receive', None, 2), {'generic': 42})
            finally:
                rpc.abort()
            self.assertIsNotNone(process.poll())

    def test_ipc_stall_kills_and_reaps_exact_owned_worker(self):
        # Local generic worker does no network; no auth/CA in argv or environment.
        import subprocess
        import sys
        import os
        process = subprocess.Popen([sys.executable, '-I', '-B', '-c', 'import time; time.sleep(10)'],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        rpc = n._ProcessRPC.__new__(n._ProcessRPC)
        rpc.process, rpc.closed = process, False
        os.set_blocking(process.stdin.fileno(), False); os.set_blocking(process.stdout.fileno(), False)
        with self.assertRaises(n.ChannelError):
            rpc.request('receive', None, .05)
        self.assertIsNotNone(process.poll()); self.assertTrue(rpc.closed)
        self.assertTrue(process.stdin.closed and process.stdout.closed)

    def test_default_worker_argv_has_no_auth_endpoint_or_config_loader(self):
        fake_process = mock.Mock()
        with mock.patch.object(n.subprocess, 'Popen', return_value=fake_process) as launch, mock.patch.object(n.os, 'set_blocking'):
            n._ProcessRPC()
        argv = launch.call_args.args[0]
        self.assertEqual(argv[-1], '--worker')
        self.assertIn('-I', argv); self.assertIn('-B', argv)
        self.assertFalse(any('generic-fixture' in value or 'wss://' in value for value in argv))
        self.assertEqual(launch.call_args.kwargs['stderr'], n.subprocess.DEVNULL)


if __name__ == '__main__':
    unittest.main()
