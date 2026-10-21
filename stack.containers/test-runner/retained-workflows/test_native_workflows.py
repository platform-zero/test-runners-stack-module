"""Synthetic protocol tests only. No network/native transport is instantiated."""
import base64
import copy
import io
import hashlib
import json
from pathlib import Path
import unittest
import zipfile

import native_workflows as n


def budget(polls=30):
    return n.Budget(seconds=20, max_polls=polls, clock=lambda: 0, sleep=lambda _: None)


class FakeChannel:
    def __init__(self, mode='ok'):
        self.mode, self.messages, self.closed = mode, [], False

    def send(self, message):
        assert message['content']['code'] == '6 * 7'
        assert message['content']['allow_stdin'] is False
        self.request = message
        parent = {'msg_id': message['header']['msg_id']}
        def event(kind, channel, content):
            return {'header': {'msg_type': kind}, 'parent_header': parent,
                    'channel': channel, 'content': content}
        # Idle deliberately arrives before shell reply; both are mandatory.
        self.messages = [
            {'parent_header': {'msg_id': 'unrelated'}, 'header': {'msg_type': 'error'}},
            event('execute_result', 'iopub', {'data': {'text/plain': '42'}, 'metadata': {}, 'execution_count': 1}),
            event('status', 'iopub', {'execution_state': 'idle'}),
            event('execute_reply', 'shell', {'status': 'ok', 'execution_count': 1})]
        if self.mode == 'wrong-output':
            self.messages[1]['content']['data']['text/plain'] = '41'
        elif self.mode == 'error':
            self.messages[1] = event('error', 'iopub', {})
        elif self.mode == 'wrong-parent':
            for msg in self.messages:
                msg['parent_header'] = {'msg_id': 'unrelated'}
        elif self.mode == 'no-reply':
            self.messages = self.messages[:-1]
        elif self.mode == 'count-mismatch':
            self.messages[-1]['content']['execution_count'] = 2

    def receive(self, timeout):
        assert 0 < timeout <= 15
        if self.messages:
            return self.messages.pop(0)
        return {'parent_header': {'msg_id': 'unrelated'}}

    def close(self):
        self.closed = True


class FakeJupyter:
    def __init__(self, mode='ok'):
        self.mode, self.trace = mode, []
        self.running, self.starts, self.saved = False, 0, None
        self.channel = FakeChannel(mode)
        self.sessions = set()

    def channels(self, path, *, timeout):
        assert path == '/user/synthetic/api/kernels/kernel1/channels'
        self.trace.append(('WS', path))
        return self.channel

    def request(self, method, path, *, payload=None, timeout):
        assert 0 < timeout <= 15
        self.trace.append((method, path))
        hub = '/hub/api/users/synthetic'
        contents = '/user/synthetic/api/contents/retained-case.ipynb'
        if path == hub and method == 'GET':
            active = self.running or self.mode == 'already-running'
            return n.Response(200, {'name': 'synthetic', 'servers': {'': {
                'ready': True, 'url': 'https://foreign.invalid/' if self.mode == 'foreign-url' else '/user/synthetic/'}} if active else {}})
        if path == hub + '/server':
            if method == 'POST':
                self.running = True
                self.starts += 1
                if self.mode == 'lost-spawn-response':
                    raise RuntimeError('PRIVATE TRANSPORT DETAIL')
                return n.Response(202)
            if method == 'DELETE':
                self.running = False
                return n.Response(204)
        if path == contents:
            if method == 'GET':
                if self.mode == 'redirect':
                    return n.Response(302)
                if self.mode == 'collision' and self.saved is None:
                    return n.Response(200, {'type': 'notebook'})
                if self.saved is None:
                    return n.Response(404)
                data = copy.deepcopy(self.saved)
                if self.mode == 'lost-persistence' and self.starts > 1:
                    data['content']['cells'][0]['outputs'] = []
                return n.Response(200, data)
            if method == 'PUT':
                status = 201 if self.saved is None else 200
                self.saved = copy.deepcopy(payload)
                return n.Response(status, copy.deepcopy(payload))
        if path == '/user/synthetic/api/sessions' and method == 'POST':
            self.sessions.add('session1')
            assert payload['kernel']['name'] == 'python3'
            assert payload['path'] == 'retained-case.ipynb'
            return n.Response(201, {'id': 'session1', 'kernel': {'id': 'kernel1', 'name': 'python3'}, 'path': payload['path']})
        if path == '/user/synthetic/api/sessions/session1' and method == 'DELETE':
            self.sessions.discard('session1')
            return n.Response(204)
        raise AssertionError('unexpected fake request')


class JupyterTests(unittest.TestCase):
    def run_workflow(self, fake):
        return n.jupyter_notebook(fake, user='synthetic', run_id='case', budget=budget())

    def test_execute_save_restart_and_reopen_exact_output(self):
        fake = FakeJupyter()
        result = self.run_workflow(fake)
        self.assertTrue(result['persistence_checked_after_respawn'])
        self.assertEqual(fake.starts, 2)
        self.assertFalse(fake.running)
        self.assertFalse(fake.sessions)
        self.assertTrue(fake.channel.closed)
        self.assertEqual(fake.saved['content']['cells'][0]['outputs'][0]['data']['text/plain'], '42')
        hub = '/hub/api/users/synthetic'
        self.assertEqual(fake.trace[:4], [('GET', hub), ('POST', hub + '/server'), ('GET', hub),
                                         ('GET', '/user/synthetic/api/contents/retained-case.ipynb')])
        self.assertEqual(fake.trace[-2:], [('DELETE', hub + '/server'), ('GET', hub)])

    def test_failures_never_pass_and_owned_resources_are_stopped(self):
        for mode in ['wrong-output', 'error', 'wrong-parent', 'no-reply', 'count-mismatch',
                     'lost-persistence', 'foreign-url', 'redirect', 'collision', 'lost-spawn-response']:
            with self.subTest(mode=mode):
                fake = FakeJupyter(mode)
                with self.assertRaises(n.WorkflowError) as caught:
                    self.run_workflow(fake)
                self.assertNotIn('PRIVATE', str(caught.exception))
                self.assertFalse(fake.running)
                self.assertFalse(fake.sessions)

    def test_existing_server_not_stopped(self):
        fake = FakeJupyter('already-running')
        with self.assertRaises(n.WorkflowError):
            self.run_workflow(fake)
        self.assertEqual(fake.trace, [('GET', '/hub/api/users/synthetic')])

    def test_path_injection_refused_before_transport(self):
        fake = FakeJupyter()
        for user in ['../other', 'https://foreign', 'user?token=x', 'a/b']:
            with self.assertRaises(n.WorkflowError):
                n.jupyter_notebook(fake, user=user)
        self.assertFalse(fake.trace)

    def test_expired_deadline_fails(self):
        ticks = iter([0, 2])
        b = n.Budget(seconds=1, clock=lambda: next(ticks))
        with self.assertRaises(n.WorkflowError):
            b.left()


def archive(content=b'retained-proof-case-42\n', name='proof.txt'):
    data = io.BytesIO()
    with zipfile.ZipFile(data, 'w', zipfile.ZIP_DEFLATED) as output:
        output.writestr(name, content)
    return data.getvalue()


BASE, SUBMITTED, BLOB = '1' * 40, '2' * 40, '3' * 40
ACTION = 'actions/upload-artifact@' + '4' * 40  # Generic fixture only; NOT an approved source pin.


class FakeForgejo:
    def __init__(self, mode='ok'):
        self.mode, self.trace, self.workflow, self.polls = mode, [], None, 0

    def request(self, method, path, *, payload=None, timeout):
        assert 0 < timeout <= 15
        self.trace.append((method, path))
        root = '/api/v1/repos/synthetic/isolated'
        if path == root + '/branches/main':
            return n.Response(200, {'commit': {'id': '9' * 40 if self.mode == 'source-moved' else BASE}})
        if path == root + '/branches':
            assert method == 'POST' and payload == {'new_branch_name': 'retained-case', 'old_ref_name': 'main'}
            return n.Response(201, {'name': 'retained-case', 'commit': {'id': '9'*40 if self.mode == 'branch-race' else BASE}})
        if path == root + '/contents/.forgejo/workflows/retained-acceptance.yml':
            assert method == 'POST' and payload['branch'] == 'retained-case'
            self.workflow = base64.b64decode(payload['content'])
            assert b'runs-on: linux' in self.workflow and ACTION.encode() in self.workflow
            return n.Response(201, {'commit': {'sha': SUBMITTED}, 'content': {'sha': BLOB}})
        if path == root + '/git/blobs/' + BLOB:
            return n.Response(200, {'encoding': 'base64', 'content': base64.b64encode(
                b'wrong' if self.mode == 'blob-mismatch' else self.workflow).decode()})
        if path == root + '/actions/runs':
            self.polls += 1
            if self.mode == 'redirect':
                return n.Response(302)
            run = {'id': 7, 'head_sha': SUBMITTED, 'head_branch': 'retained-case',
                   'event': 'push', 'status': 'completed', 'conclusion': 'success'}
            if self.mode == 'other-sha':
                run['head_sha'] = BASE
            elif self.mode == 'wrong-branch':
                run['head_branch'] = 'main'
            elif self.mode == 'wrong-event':
                run['event'] = 'workflow_dispatch'
            elif self.mode == 'failed-run':
                run['conclusion'] = 'failure'
            elif self.mode == 'queued' and self.polls == 1:
                run.update(status='queued', conclusion=None)
            return n.Response(200, {'workflow_runs': [run, copy.deepcopy(run)] if self.mode == 'ambiguous' else [run]})
        if path == root + '/actions/runs/7/jobs':
            job = {'name': 'synthetic-proof', 'status': 'completed', 'conclusion': 'success', 'runner_id': 8}
            if self.mode == 'no-runner':
                job['runner_id'] = None
            if self.mode == 'failed-job':
                job['conclusion'] = 'failure'
            return n.Response(200, {'total_count': 2 if self.mode == 'paginated-jobs' else 1, 'jobs': [job]})
        if path == root + '/actions/runs/7/artifacts':
            return n.Response(200, {'total_count': 1, 'artifacts': [{'id': 9, 'name': 'retained-proof', 'expired': self.mode == 'expired-artifact'}]})
        if path == root + '/actions/artifacts/9/zip':
            return n.Response(200, body=archive(b'wrong') if self.mode == 'wrong-bytes' else archive())
        raise AssertionError('unexpected fake request')


class ForgejoTests(unittest.TestCase):
    def run_workflow(self, fake, action=ACTION):
        return n.forgejo_runner(fake, owner='synthetic', repo='isolated', source_branch='main',
                                source_commit=BASE, upload_action=action, run_id='case', budget=budget())

    def test_exact_commit_native_runner_and_artifact_bytes(self):
        fake = FakeForgejo('queued')
        result = self.run_workflow(fake)
        self.assertEqual((result['submitted_commit'], result['runner_id'], result['artifact_id']), (SUBMITTED, 8, 9))
        self.assertEqual(fake.polls, 2)
        self.assertEqual(fake.trace[-1], ('GET', '/api/v1/repos/synthetic/isolated/actions/artifacts/9/zip'))
        self.assertIn('cleanup_required', result)

    def test_protocol_rejections(self):
        for mode in ['source-moved', 'branch-race', 'blob-mismatch', 'redirect', 'other-sha',
                     'wrong-branch', 'wrong-event', 'failed-run', 'ambiguous', 'no-runner',
                     'failed-job', 'paginated-jobs', 'expired-artifact', 'wrong-bytes']:
            with self.subTest(mode=mode):
                with self.assertRaises(n.WorkflowError):
                    self.run_workflow(FakeForgejo(mode))

    def test_action_floating_refs_refused_before_transport(self):
        for action in ['actions/upload-artifact@v3', 'https://foreign/action@' + '4'*40, 'action@main']:
            fake = FakeForgejo()
            with self.assertRaises(n.WorkflowError):
                self.run_workflow(fake, action)
            self.assertFalse(fake.trace)

    def test_archive_rejects_bad_paths_extra_entries_and_size(self):
        for body in [archive(name='../proof.txt'), archive(b'wrong'), b'notzip', b'x'*(1024*1024+1)]:
            with self.subTest(size=len(body)):
                with self.assertRaises(n.WorkflowError):
                    n.verify_archive(body, b'retained-proof-case-42\n')
        stream = io.BytesIO()
        with zipfile.ZipFile(stream, 'w') as z:
            z.writestr('proof.txt', b'retained-proof-case-42\n')
            z.writestr('extra', b'not expected')
        with self.assertRaises(n.WorkflowError):
            n.verify_archive(stream.getvalue(), b'retained-proof-case-42\n')

    def test_transport_error_is_sanitized(self):
        class Broken:
            def request(self, *args, **kwargs):
                raise RuntimeError('PRIVATE TRANSPORT DETAIL')
        with self.assertRaises(n.WorkflowError) as caught:
            self.run_workflow(Broken())
        self.assertNotIn('PRIVATE', str(caught.exception))


# Reviewed public declarations only, not installed-state/native execution proof.
# Full blobs were verified read-only at preparation; images need neither Git nor
# sibling repositories. Updating any pin/excerpt requires explicit source review.
PUBLIC_CONTRACTS_SHA256 = '307a9b4e0b1be6f7d31bcba4f8241d1e6a13313845d5a4cc61503a90730befbb'
PUBLIC_SOURCE_CONTRACTS = {
    ('jupyterhub', 'stack.config/jupyterhub/jupyterhub_config.py'): (
        '16fa942d8524e010438d088635ab089c03895a1f',
        '5e252e3ced66daf2452daa200eace757e334da40589388fd3533724ea3787791',
        'b0916b22918fbac8a6e2a54a7fae8a980576aec09abcb76368905b7cf60f5d54', [95, 114, 123]),
    ('forgejo', 'stack.runtime.yaml'): (
        'b67d90ab484804d64ca157e11859a702411dae46',
        'e8efe6bc3c8ce24cfd9cd7a08c45deb417c14d584f3b7731ca481b7359dc0c78',
        'ed11f6b319b8c378a62e6147593aacf936c6c91ed76bb11e0f92f4eed3ca5617', [42]),
    ('forgejo', 'stack.containers/forgejo-bootstrap/Containerfile'): (
        'b67d90ab484804d64ca157e11859a702411dae46',
        '77984bbcb1ca44cab4c7b234f7528b1475b22861c4990b2299bf2df19654b08a',
        '35f6a1f413677c2951b9a5273d51f7582d8d8de44b736eb16d897701ae69f745', [9]),
    ('forgejo-runner', 'stack.config/forgejo-runner/config.yaml'): (
        '5681039ee739d7ac8e5dcf469dde36c05829be1e',
        '591efcd82e45ccdc83d21f29e3bb02c8864410bee74fd34e3e3b317144d3c831',
        '458005b127a3e9aed14a491ea6cbf461a0437286d7ef4a6737507d82a2abec3d', [20, 31]),
}


def _contract_require(condition, reason):
    if not condition:
        raise AssertionError('public-source-contracts: ' + reason)


def _contract_object(pairs):
    result = {}
    for key, value in pairs:
        _contract_require(key not in result, 'duplicate-key')
        result[key] = value
    return result


def load_public_source_contracts(path):
    """Fail closed on absent/malformed/changed public fixture; never skip."""
    try:
        raw = path.read_bytes()
    except OSError:
        raise AssertionError('public-source-contracts: missing-or-unreadable') from None
    _contract_require(0 < len(raw) <= 32768, 'size')
    try:
        data = json.loads(raw.decode('utf-8'), object_pairs_hook=_contract_object)
    except (ValueError, UnicodeError):
        raise AssertionError('public-source-contracts: malformed-json') from None
    _contract_require(type(data) is dict and set(data) == {'version', 'scope', 'sources'}, 'schema')
    _contract_require(type(data['version']) is int and data['version'] == 1, 'version')
    _contract_require(data['scope'] == 'public-pinned-source-declarations-only', 'scope')
    _contract_require(type(data['sources']) is list and len(data['sources']) == 4, 'sources')
    result = {}
    keys = {'module', 'repository', 'commit', 'path', 'source_url', 'source_sha256',
            'line_numbers', 'excerpt', 'excerpt_sha256', 'license'}
    for entry in data['sources']:
        _contract_require(type(entry) is dict and set(entry) == keys, 'entry-schema')
        _contract_require(type(entry['module']) is str and type(entry['path']) is str, 'source-identity')
        key = (entry['module'], entry['path'])
        _contract_require(key in PUBLIC_SOURCE_CONTRACTS and key not in result, 'source-identity')
        pin, source_sha, excerpt_sha, numbers = PUBLIC_SOURCE_CONTRACTS[key]
        _contract_require(entry['commit'] == pin, 'pin')
        repo = 'https://github.com/platform-zero/' + entry['module'] + '-stack-module'
        _contract_require(entry['repository'] == repo + '.git' and
                          entry['source_url'] == repo + '/blob/' + pin + '/' + entry['path'], 'public-source-url')
        _contract_require(entry['source_sha256'] == source_sha, 'full-source-sha256')
        _contract_require(type(entry['line_numbers']) is list and entry['line_numbers'] == numbers and
                          all(type(number) is int for number in entry['line_numbers']), 'line-numbers')
        _contract_require(type(entry['excerpt']) is str, 'excerpt')
        _contract_require(hashlib.sha256(entry['excerpt'].encode()).hexdigest() == excerpt_sha ==
                          entry['excerpt_sha256'], 'excerpt-sha256')
        _contract_require(entry['license'] == {
            'spdx': 'AGPL-3.0-or-later', 'copyright': 'Copyright (C) 2026 Gerald Summers.',
            'notice_url': repo + '/blob/' + pin + '/LICENSE-NOTICE.md',
            'license_url': repo + '/blob/' + pin + '/LICENSE'}, 'license-attribution')
        result[key] = entry['excerpt']
    _contract_require(set(result) == set(PUBLIC_SOURCE_CONTRACTS), 'required-sources')
    _contract_require(hashlib.sha256(raw).hexdigest() == PUBLIC_CONTRACTS_SHA256, 'fixture-sha256')
    return result


class PinnedSourceContracts(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        contracts = load_public_source_contracts(Path(__file__).with_name('public-source-contracts.json'))
        class PublicSource:
            def __init__(self, module):
                self.module = module
            def text(self, path):
                _contract_require((self.module, path) in contracts, 'undeclared-source')
                return contracts[(self.module, path)]
        cls.hub = PublicSource('jupyterhub')
        cls.forgejo = PublicSource('forgejo')
        cls.runner = PublicSource('forgejo-runner')

    def test_hub_source_declares_spawn_and_per_user_persistent_volume(self):
        text = self.hub.text('stack.config/jupyterhub/jupyterhub_config.py')
        self.assertIn("c.JupyterHub.spawner_class = 'dockerspawner.DockerSpawner'", text)
        self.assertIn("'jupyterhub-user-{username}': NOTEBOOK_WORKDIR", text)
        self.assertIn("c.Spawner.default_url = '/lab'", text)

    def test_selected_forgejo_has_actions_and_pinned_image(self):
        runtime = self.forgejo.text('stack.runtime.yaml')
        build = self.forgejo.text('stack.containers/forgejo-bootstrap/Containerfile')
        self.assertIn('FORGEJO__actions__ENABLED: true', runtime)
        self.assertIn('forgejo:14.0.2@sha256:', build)

    def test_runner_linux_label_and_unprivileged_container(self):
        config = self.runner.text('stack.config/forgejo-runner/config.yaml')
        self.assertIn('linux:docker://node:20-bookworm', config)
        self.assertIn('privileged: false', config)


if __name__ == '__main__':
    unittest.main()
