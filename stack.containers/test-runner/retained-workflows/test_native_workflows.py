"""Synthetic protocol tests only. No network/native transport is instantiated."""
import base64
import copy
import io
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


class PinnedSourceContracts(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from pathlib import Path
        import subprocess
        # Public module checkout layout only; no dependency on private helper/audit
        # workspace files. Generic transport tests also run in packaged images.
        modules = Path(__file__).resolve().parents[4]
        if not all((modules / name / '.git').exists() for name in ('jupyterhub', 'forgejo', 'forgejo-runner')):
            raise unittest.SkipTest('public source sibling repositories unavailable')
        class PublicSource:
            def __init__(self, repository, pin):
                self.repository, self.pin = repository, pin
            def text(self, path):
                result = subprocess.run(['git', '-C', str(self.repository), 'show', self.pin + ':' + path],
                                        capture_output=True, text=True, timeout=10)
                if result.returncode:
                    raise AssertionError('immutable public source declaration unavailable')
                return result.stdout
        cls.hub = PublicSource(modules / 'jupyterhub', '16fa942d8524e010438d088635ab089c03895a1f')
        cls.forgejo = PublicSource(modules / 'forgejo', 'b67d90ab484804d64ca157e11859a702411dae46')
        cls.runner = PublicSource(modules / 'forgejo-runner', '5681039ee739d7ac8e5dcf469dde36c05829be1e')

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
