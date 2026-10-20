"""Source-only retained acceptance adapters; no network implementation or CLI.

Caller supplies separately authenticated, same-origin HTTP / Jupyter WebSocket
transports. Never put auth in adapter arguments, paths, return values or logs.
Only isolated disposable users/repositories are authorized integration targets.
"""
from __future__ import annotations

import base64
import io
import re
import time
import uuid
import zipfile
from datetime import datetime, timezone
from dataclasses import dataclass
from typing import Any, Protocol
from urllib.parse import quote


class WorkflowError(RuntimeError):
    """Deliberately payload-free failure; never embeds transport exceptions."""


@dataclass(frozen=True)
class Response:
    status: int
    data: Any = None
    body: bytes = b''


class Channel(Protocol):
    def send(self, message: dict) -> None: ...
    def receive(self, timeout: float) -> dict: ...
    def close(self) -> None: ...


class Transport(Protocol):
    # Must disable redirects, enforce TLS/trust and origin, bound bytes, redact
    # exceptions, keep credentials private, and enforce timeout on EACH call.
    def request(self, method: str, path: str, *, payload=None, timeout: float) -> Response: ...
    def channels(self, path: str, *, timeout: float) -> Channel: ...


class Budget:
    def __init__(self, seconds=120, max_polls=100, clock=time.monotonic, sleep=time.sleep):
        if seconds <= 0 or max_polls < 1:
            raise ValueError('Invalid finite operation budget')
        self.clock, self.sleep = clock, sleep
        self.deadline, self.remaining_polls = clock() + seconds, max_polls

    def left(self):
        left = self.deadline - self.clock()
        if left <= 0:
            raise WorkflowError('workflow deadline exceeded')
        return min(left, 15.0)

    def pause(self):
        self.remaining_polls -= 1
        if self.remaining_polls <= 0:
            raise WorkflowError('workflow polling limit exceeded')
        self.sleep(min(0.1, self.left()))


def require(condition, message):
    if not condition:
        raise WorkflowError(message)


def identifier(value):
    require(isinstance(value, str) and bool(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,79}', value)), 'invalid isolated identifier')
    return quote(value, safe='')


def commit_sha(value):
    require(isinstance(value, str) and bool(re.fullmatch('[0-9a-f]{40}', value)), 'immutable commit required')
    return value


def call(transport, budget, method, path, statuses=(200,), payload=None):
    require(path.startswith('/') and not path.startswith('//') and '?' not in path, 'invalid relative API path')
    try:
        response = transport.request(method, path, payload=payload, timeout=budget.left())
    except Exception:
        raise WorkflowError('transport request failed (details withheld)') from None
    require(response.status in statuses, 'unexpected API status (redirect/auth/error cannot pass)')
    return response


def ready_user(transport, budget, user, ready):
    path = '/hub/api/users/' + user
    while True:
        model = call(transport, budget, 'GET', path).data
        require(isinstance(model, dict) and model.get('name') == user, 'Hub user identity mismatch')
        server = model.get('servers', {}).get('')
        if ready and server and server.get('ready') is True and not server.get('pending'):
            expected = '/user/' + user + '/'
            require(server.get('url') == expected, 'unexpected single-user server origin/path')
            return expected
        if not ready and not server and not model.get('pending'):
            return None
        budget.pause()


def assert_notebook(model, expected):
    require(isinstance(model, dict) and model.get('type') == 'notebook', 'notebook contents model missing')
    require(model.get('content') == expected, 'saved notebook content/output did not persist exactly')


def jupyter_notebook(transport: Transport, *, user: str, budget=None, run_id=None):
    """Own default-server spawn -> execute -> save -> stop/respawn -> read.

    Refuses an already-running server: never stop someone's existing notebook.
    Notebook remains as a small synthetic proof artifact; no real files are read.
    Synthetic session/server are cleaned up on success and failure, with independent
    bounded cleanup budget. Transport must use an owner-scoped authenticated user.
    """
    budget = budget or Budget()
    user = identifier(user)
    run_id = identifier(run_id or uuid.uuid4().hex)
    hub = '/hub/api/users/' + user
    filename = 'retained-' + run_id + '.ipynb'
    base = '/user/' + user + '/'
    contents = base + 'api/contents/' + filename
    session_id, owns_server, channel = None, False, None
    result = None
    try:
        model = call(transport, budget, 'GET', hub).data
        require(model.get('name') == user and not model.get('servers') and not model.get('pending'), 'requires idle isolated Hub user')
        # The user server does not exist yet: collision check occurs after spawn.
        # Refuse same-name contents after spawn, before any write.
        owns_server = True  # POST may be accepted even if its response is lost.
        call(transport, budget, 'POST', hub + '/server', statuses=(201, 202), payload={})
        ready_user(transport, budget, user, True)
        call(transport, budget, 'GET', contents, statuses=(404,))
        notebook = {'nbformat': 4, 'nbformat_minor': 5, 'metadata': {}, 'cells': [
            {'id': 'synthetic-cell', 'cell_type': 'code', 'metadata': {},
             'source': '6 * 7', 'execution_count': None, 'outputs': []}]}
        call(transport, budget, 'PUT', contents, statuses=(201,), payload={'type': 'notebook', 'format': 'json', 'content': notebook})
        session = call(transport, budget, 'POST', base + 'api/sessions', statuses=(201,), payload={
            'path': filename, 'name': filename, 'type': 'notebook', 'kernel': {'name': 'python3'}}).data
        session_id = identifier(session['id'])
        kernel_id = identifier(session['kernel']['id'])
        require(session['kernel'].get('name') == 'python3', 'session kernel specification mismatch')
        require(session.get('path') == filename, 'kernel session notebook mismatch')
        msg_id = uuid.uuid4().hex
        try:
            channel = transport.channels(base + 'api/kernels/' + kernel_id + '/channels', timeout=budget.left())
            channel.send({'header': {'msg_id': msg_id, 'username': 'synthetic', 'session': run_id,
                                    'msg_type': 'execute_request', 'version': '5.3',
                                    'date': datetime.now(timezone.utc).isoformat()}, 
                          'parent_header': {}, 'metadata': {}, 'channel': 'shell',
                          'content': {'code': '6 * 7', 'silent': False, 'store_history': True,
                                      'user_expressions': {}, 'allow_stdin': False, 'stop_on_error': True}})
            reply, idle, output, count = False, False, None, None
            while not (reply and idle and output is not None):
                message = channel.receive(timeout=budget.left())
                if message.get('parent_header', {}).get('msg_id') != msg_id:
                    budget.pause()
                    continue
                kind = message.get('header', {}).get('msg_type')
                body = message.get('content', {})
                if kind == 'error':
                    raise WorkflowError('kernel execution failed')
                if kind == 'execute_reply':
                    require(message.get('channel') == 'shell' and body.get('status') == 'ok', 'kernel reply not successful')
                    count = body.get('execution_count')
                    require(isinstance(count, int) and not isinstance(count, bool) and count > 0, 'invalid kernel execution count')
                    reply = True
                if kind == 'execute_result':
                    require(message.get('channel') == 'iopub' and body.get('data', {}).get('text/plain') == '42', 'unexpected synthetic cell output')
                    output = {'output_type': 'execute_result', 'data': body['data'], 'metadata': body.get('metadata', {}),
                              'execution_count': body.get('execution_count')}
                if kind == 'status' and message.get('channel') == 'iopub' and body.get('execution_state') == 'idle':
                    idle = True
                budget.pause()
        except WorkflowError:
            raise
        except Exception:
            raise WorkflowError('kernel channel failed (details withheld)') from None
        finally:
            if channel:
                channel.close()
                channel = None
        require(output['execution_count'] == count, 'kernel result/reply count mismatch')
        notebook['cells'][0].update(execution_count=count, outputs=[output])
        call(transport, budget, 'PUT', contents, statuses=(200,), payload={'type': 'notebook', 'format': 'json', 'content': notebook})
        assert_notebook(call(transport, budget, 'GET', contents).data, notebook)
        call(transport, budget, 'DELETE', base + 'api/sessions/' + session_id, statuses=(204,))
        session_id = None
        call(transport, budget, 'DELETE', hub + '/server', statuses=(202, 204))
        ready_user(transport, budget, user, False)
        call(transport, budget, 'POST', hub + '/server', statuses=(201, 202), payload={})
        ready_user(transport, budget, user, True)
        assert_notebook(call(transport, budget, 'GET', contents).data, notebook)
        result = {'workflow': 'jupyter-execute-save-respawn', 'synthetic_notebook': filename,
                  'expected_output': '42', 'persistence_checked_after_respawn': True}
    except WorkflowError:
        raise
    except Exception:
        raise WorkflowError('invalid native protocol model (details withheld)') from None
    finally:
        if owns_server:
            cleanup = Budget(seconds=30, max_polls=50)
            try:
                if session_id:
                    call(transport, cleanup, 'DELETE', base + 'api/sessions/' + session_id, statuses=(204, 404))
            finally:
                call(transport, cleanup, 'DELETE', hub + '/server', statuses=(202, 204, 404))
                ready_user(transport, cleanup, user, False)
    return result


def synthetic_workflow(branch, upload_action, marker):
    identifier(branch)
    require(bool(re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+@[0-9a-f]{40}', upload_action)), 'upload action requires reviewed immutable source pin')
    # Action pin is explicitly supplied by release integration, never invented or
    # resolved at runtime. The action must support Forgejo's artifact service.
    return ('name: retained-acceptance\non:\n  push:\n    branches: [' + branch + ']\n'
            'jobs:\n  synthetic-proof:\n    runs-on: linux\n    timeout-minutes: 2\n'
            '    steps:\n      - name: Produce deterministic synthetic artifact\n'
            "        run: printf '%s\\n' '" + marker + "' > proof.txt\n"
            '      - uses: ' + upload_action + '\n        with:\n'
            '          name: retained-proof\n          path: proof.txt\n'
            '          if-no-files-found: error\n')


def verify_archive(body, expected):
    require(isinstance(body, bytes) and len(body) <= 1024 * 1024, 'artifact archive size invalid')
    try:
        with zipfile.ZipFile(io.BytesIO(body)) as archive:
            entries = archive.infolist()
            require(len(entries) == 1 and entries[0].filename == 'proof.txt', 'artifact archive entry mismatch')
            info = entries[0]
            require(info.file_size == len(expected) and not info.flag_bits & 1, 'artifact entry size/encryption mismatch')
            mode = info.external_attr >> 16
            require(mode & 0o170000 in (0, 0o100000), 'artifact non-regular file rejected')
            require(archive.read(info) == expected, 'runner artifact content mismatch')
    except WorkflowError:
        raise
    except Exception:
        raise WorkflowError('invalid runner artifact archive') from None


def forgejo_runner(transport: Transport, *, owner, repo, source_branch, source_commit,
                   upload_action, run_id=None, budget=None):
    """Create a unique branch/file commit; require exact-SHA real run/job/artifact.

    Existing isolated repo and Actions-enabled default/source branch are required.
    No runner registration/token provisioning is performed. Synthetic branch/run
    retained for lead inspection/owned cleanup; never delete arbitrary repositories.
    Uses Forgejo/Gitea-compatible /api/v1 Actions REST shapes, strict fail-closed.
    """
    budget = budget or Budget()
    owner, repo, source_branch = map(identifier, (owner, repo, source_branch))
    source_commit = commit_sha(source_commit)
    run_id = identifier(run_id or uuid.uuid4().hex)
    branch = 'retained-' + run_id
    identifier(branch)
    marker = 'retained-proof-' + run_id + '-42'
    workflow = synthetic_workflow(branch, upload_action, marker)
    root = '/api/v1/repos/' + owner + '/' + repo
    current = call(transport, budget, 'GET', root + '/branches/' + source_branch).data
    require(current.get('commit', {}).get('id') == source_commit, 'source branch does not match approved commit')
    created = call(transport, budget, 'POST', root + '/branches', statuses=(201,), payload={
        'new_branch_name': branch, 'old_ref_name': source_branch}).data
    require(created.get('name') == branch and created.get('commit', {}).get('id') == source_commit, 'branch creation race or mismatch')
    path = '.forgejo/workflows/retained-acceptance.yml'
    submitted = call(transport, budget, 'POST', root + '/contents/' + path, statuses=(201,), payload={
        'branch': branch, 'message': 'Synthetic retained runner acceptance',
        'content': base64.b64encode(workflow.encode()).decode()}).data
    sha = commit_sha(submitted.get('commit', {}).get('sha'))
    require(sha != source_commit, 'workflow submission did not create a new commit')
    # Verify committed bytes, not only a successful create response.
    stored = call(transport, budget, 'GET', root + '/git/blobs/' + commit_sha(submitted['content']['sha'])).data
    require(stored.get('encoding') == 'base64', 'workflow blob encoding mismatch')
    try:
        require(base64.b64decode(stored['content'], validate=True) == workflow.encode(), 'committed workflow bytes mismatch')
    except (ValueError, KeyError):
        raise WorkflowError('invalid workflow blob') from None
    while True:
        runs = call(transport, budget, 'GET', root + '/actions/runs').data
        require(isinstance(runs, dict) and isinstance(runs.get('workflow_runs'), list), 'unsupported Actions runs API')
        # Unique commit created in this operation: unrelated successful runs cannot pass.
        matches = [r for r in runs['workflow_runs'] if r.get('head_sha') == sha and r.get('head_branch') == branch and r.get('event') == 'push']
        require(len(matches) <= 1, 'ambiguous commit-bound Actions runs')
        if matches:
            run = matches[0]
            if run.get('status') == 'completed':
                require(run.get('conclusion') == 'success', 'Actions run did not succeed')
                break
            require(run.get('conclusion') in (None, ''), 'Actions run reached failed terminal state')
        budget.pause()
    native_id = run.get('id')
    require(type(native_id) is int and native_id > 0, 'invalid Actions run id')
    jobs = call(transport, budget, 'GET', root + '/actions/runs/' + str(native_id) + '/jobs').data
    require(jobs.get('total_count') == 1 and len(jobs.get('jobs', [])) == 1, 'expected exactly one unpaginated runner job')
    job = jobs['jobs'][0]
    require(job.get('name') == 'synthetic-proof' and job.get('status') == 'completed' and job.get('conclusion') == 'success', 'synthetic runner job incomplete/failed')
    require(type(job.get('runner_id')) is int and job['runner_id'] > 0, 'job has no assigned native runner')
    artifacts = call(transport, budget, 'GET', root + '/actions/runs/' + str(native_id) + '/artifacts').data
    require(artifacts.get('total_count') == 1 and len(artifacts.get('artifacts', [])) == 1, 'expected exactly one run-bound artifact')
    artifact = artifacts['artifacts'][0]
    require(artifact.get('name') == 'retained-proof' and artifact.get('expired') is False, 'artifact missing/expired')
    artifact_id = artifact.get('id')
    require(type(artifact_id) is int and artifact_id > 0, 'invalid artifact id')
    archive = call(transport, budget, 'GET', root + '/actions/artifacts/' + str(artifact_id) + '/zip').body
    verify_archive(archive, (marker + '\n').encode())
    return {'workflow': 'forgejo-commit-runner-artifact', 'submitted_commit': sha,
            'run_id': native_id, 'runner_id': job['runner_id'], 'artifact_id': artifact_id,
            'synthetic_branch': branch, 'cleanup_required': 'Delete only this owned branch/run/artifact after lead review.'}
