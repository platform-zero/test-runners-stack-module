"""All I/O fake; public pinned source checks only. Never contacts an endpoint."""
import copy
import json
import ssl
import unittest
from types import SimpleNamespace

from document_workflows import bookstack_document, capture_bookstack_page, seafile_roundtrip
from native_workflows import Budget, WorkflowError
from scoped_https import ScopedHTTPS


class Connection:
    def __init__(self, payload=b'{}', status=200, content_type='application/json', broken=False):
        self.payload, self.status, self.content_type = payload, status, content_type
        self.broken, self.closed, self.read_limit, self.calls = broken, False, None, []

    def request(self, method, path, *, body, headers):
        if self.broken:
            raise RuntimeError('PRIVATE TEST DETAIL')
        self.calls.append((method, path, body, copy.deepcopy(headers)))

    def getresponse(self):
        return self

    def getheader(self, key, default):
        return self.content_type

    def read(self, amount):
        self.read_limit = amount
        return self.payload[:amount]

    def close(self):
        self.closed = True


class HTTPTests(unittest.TestCase):
    def client(self, connection=None, **kwargs):
        self.connection = connection or Connection()
        self.created = []
        def factory(host, port, *, timeout, context):
            self.created.append((host, port, timeout, context))
            return self.connection
        return ScopedHTTPS('https://isolated.example.invalid', allowed_prefixes=('/api/books', '/api/pages', '/api/search'),
                           headers=lambda: {}, connection_factory=factory, **kwargs)

    def test_json_request_and_response_connection_closed(self):
        client = self.client(Connection(b'{"id": 7}'))
        result = client.request('POST', '/api/books', payload={'name': 'Synthetic'}, timeout=3)
        self.assertEqual(result.data, {'id': 7})
        self.assertEqual(self.created[0][:3], ('isolated.example.invalid', 443, 3))
        self.assertEqual(json.loads(self.connection.calls[0][2]), {'name': 'Synthetic'})
        self.assertTrue(self.connection.closed)

    def test_redirect_never_followed(self):
        client = self.client(Connection(status=302))
        self.assertEqual(client.request('GET', '/api/books', timeout=3).status, 302)
        self.assertEqual(len(self.created), 1)
        self.assertEqual(len(self.connection.calls), 1)

    def test_namespace_and_encoded_traversal_rejected_before_connect(self):
        client = self.client()
        for path in ['https://foreign.invalid/api/books', '//foreign/api/books', '/api/booksevil',
                     '/api/pages/../private', '/api/pages/%2e%2e/private', '/api/pages/%252e%252e/private',
                     '/api/pages/%5cprivate', '/api/pages/x\nHost: foreign', '/private', '/api/books#fragment']:
            with self.subTest(path=path):
                with self.assertRaises(WorkflowError):
                    client.request('GET', path, timeout=3)
        self.assertFalse(self.created)

    def test_response_size_and_json_decode_fail_closed(self):
        for body, limit in [(b'x'*20, 10), (b'not-json', 100)]:
            with self.subTest(body_size=len(body)):
                client = self.client(Connection(body), max_response_bytes=limit)
                with self.assertRaises(WorkflowError):
                    client.request('GET', '/api/books', timeout=3)
                self.assertTrue(self.connection.closed)
                self.assertEqual(self.connection.read_limit, limit + 1)

    def test_binary_archive_returned_without_json_decode(self):
        client = self.client(Connection(b'PK-synthetic', content_type='application/zip'))
        result = client.request('GET', '/api/books', timeout=3)
        self.assertEqual(result.body, b'PK-synthetic')
        self.assertIsNone(result.data)

    def test_tls_disabled_and_userinfo_origin_refused(self):
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE
        with self.assertRaises(WorkflowError):
            self.client(context=context)
        for origin in ['http://isolated.example.invalid', 'https://name@host.invalid', 'https://host.invalid/path']:
            with self.assertRaises(WorkflowError):
                ScopedHTTPS(origin, allowed_prefixes=('/api',), headers=lambda: {})

    def test_private_callback_exception_and_header_injection_are_sanitized(self):
        client = self.client()
        def broken():
            raise RuntimeError('PRIVATE TEST DETAIL')
        for callback in [broken, lambda: {'Host': 'foreign.invalid'}, lambda: {'Cookie': 'a\nb'}]:
            client.headers = callback
            with self.assertRaises(WorkflowError) as caught:
                client.request('GET', '/api/books', timeout=3)
            self.assertNotIn('PRIVATE', str(caught.exception))
        self.assertFalse(self.created)

    def test_network_exception_sanitized_and_connection_closed(self):
        client = self.client(Connection(broken=True))
        with self.assertRaises(WorkflowError) as caught:
            client.request('GET', '/api/books', timeout=3)
        self.assertNotIn('PRIVATE', str(caught.exception))
        self.assertTrue(self.connection.closed)

    def test_tls_mutation_and_encoded_aliases_rejected(self):
        client = self.client()
        with self.assertRaises(WorkflowError):
            client.request('GET', '/api/books/%31', timeout=3)
        client.context.check_hostname = False
        client.context.verify_mode = ssl.CERT_NONE
        with self.assertRaises(WorkflowError):
            client.request('GET', '/api/books', timeout=3)
        self.assertFalse(self.created)

    def test_multipart_upload_wire_bytes_and_no_filename_injection(self):
        client = self.client(Connection(b'[]'))
        client.prefixes = ('/seafhttp/upload-api',)
        client.upload('/seafhttp/upload-api/synthetic?ret-json=1', filename='proof.txt', content=b'synthetic-42\n', timeout=3)
        method, path, body, headers = self.connection.calls[0]
        self.assertEqual(method, 'POST')
        boundary = headers['Content-Type'].split('boundary=')[1].encode()
        self.assertIn(b'filename="proof.txt"\r\n', body)
        self.assertIn(b'name="parent_dir"\r\n\r\n/\r\n', body)
        self.assertIn(b'synthetic-42\n\r\n--' + boundary + b'--\r\n', body)
        for filename in ['../proof.txt', 'proof".txt', 'proof\n.txt']:
            with self.assertRaises(WorkflowError):
                client.upload('/seafhttp/upload-api/synthetic', filename=filename, content=b'42', timeout=3)
        self.assertEqual(len(self.created), 1)

    def test_channel_factory_receives_only_bound_origin_path_timeout(self):
        calls = []
        client = self.client(channel_factory=lambda origin, path, **kw: calls.append((origin, path, kw)) or 'channel')
        self.assertEqual(client.channels('/api/pages/1', timeout=2), 'channel')
        self.assertEqual(calls, [('https://isolated.example.invalid', '/api/pages/1', {'timeout': 2})])
        with self.assertRaises(WorkflowError):
            self.client().channels('/api/pages/1', timeout=2)


class Documents:
    def __init__(self, mode='ok'):
        self.mode, self.calls, self.page, self.book, self.searches = mode, [], None, None, 0

    def request(self, method, path, *, payload=None, timeout):
        self.calls.append((method, path))
        if self.mode == 'redirect' and method == 'POST':
            return SimpleNamespace(status=302, data=None)
        if method == 'POST' and path == '/api/books':
            self.book = {'id': 7, 'name': payload['name'], 'slug': 'synthetic-book'}
            return SimpleNamespace(status=200, data=copy.deepcopy(self.book))
        if method == 'POST' and path == '/api/pages':
            self.page = {**payload, 'id': 8, 'slug': 'synthetic-page'}
            return SimpleNamespace(status=200, data=copy.deepcopy(self.page))
        if method == 'PUT' and path == '/api/pages/8':
            if self.mode != 'lost-update':
                self.page.update(payload)
            return SimpleNamespace(status=200, data=copy.deepcopy(self.page))
        if method == 'GET' and path == '/api/pages/8':
            result = copy.deepcopy(self.page)
            if result and self.mode == 'wrong-owner':
                result['book_id'] = 99
            return SimpleNamespace(status=200 if result else 404, data=result)
        if method == 'GET' and path == '/api/books/7':
            return SimpleNamespace(status=200 if self.book else 404, data=self.book)
        if method == 'DELETE' and path == '/api/pages/8':
            self.page = None
            return SimpleNamespace(status=204, data=None)
        if method == 'DELETE' and path == '/api/books/7':
            self.book = None
            return SimpleNamespace(status=204, data=None)
        if method == 'GET' and path.startswith('/api/search?query=retained-document-case'):
            self.searches += 1
            found = self.mode != 'search-miss' and (self.mode != 'delayed-search' or self.searches > 1)
            return SimpleNamespace(status=200, data={'data': [{'type': 'page', 'id': 8, 'name': 'Retained case'}] if found else []})
        raise AssertionError('unexpected fake document request')


def budget():
    return Budget(seconds=10, max_polls=5, clock=lambda: 0, sleep=lambda _: None)


class DocumentTests(unittest.TestCase):
    def test_create_update_reopen_search_capture_before_cleanup(self):
        transport, captures = Documents('delayed-search'), []
        def capture(path, title, marker):
            self.assertIsNotNone(transport.page)
            captures.append((path, title, marker))
            return {'reference': 'synthetic-only'}
        result = bookstack_document(transport, run_id='case', budget=budget(), capture=capture)
        self.assertEqual(result['page_id'], 8)
        self.assertEqual(transport.searches, 2)
        self.assertEqual(captures, [('/books/synthetic-book/page/synthetic-page', 'Retained case',
                                     'retained-document-case updated and reopened')])
        self.assertIsNone(transport.book)
        self.assertIsNone(transport.page)
        self.assertEqual(transport.calls[-4:], [('DELETE', '/api/pages/8'), ('GET', '/api/pages/8'),
                                                ('DELETE', '/api/books/7'), ('GET', '/api/books/7')])

    def test_failure_cleans_owned_resources(self):
        for mode in ['wrong-owner', 'lost-update', 'search-miss', 'redirect']:
            with self.subTest(mode=mode):
                transport = Documents(mode)
                with self.assertRaises(WorkflowError):
                    bookstack_document(transport, run_id='case', budget=budget())
                self.assertIsNone(transport.book)
                self.assertIsNone(transport.page)

    def test_browser_failure_still_cleans(self):
        transport = Documents()
        def bad_capture(*args):
            raise RuntimeError('PRIVATE TEST DETAIL')
        with self.assertRaises(WorkflowError) as caught:
            bookstack_document(transport, run_id='case', budget=budget(), capture=bad_capture)
        self.assertNotIn('PRIVATE', str(caught.exception))
        self.assertIsNone(transport.book)


class Locator:
    def __init__(self, page, kind):
        self.page, self.kind = page, kind

    def count(self):
        return 0 if self.page.mode == 'missing-heading' and self.kind == 'heading' else 1

    def wait_for(self, **kwargs):
        return None

    def is_visible(self):
        if self.kind == 'password':
            return self.page.mode == 'login'
        return True

    def inner_text(self, **kwargs):
        return 'old unrelated page' if self.page.mode == 'wrong-content' else 'retained-document-case updated and reopened'


class Browser:
    def __init__(self, mode='ok'):
        self.mode, self.url = mode, None

    def goto(self, target, **kwargs):
        self.url = target + '/login' if self.mode == 'redirect' else target
        return SimpleNamespace(status=200)

    def get_by_role(self, role, *, name, exact):
        assert role == 'heading' and name == 'Retained case' and exact
        return Locator(self, 'heading')

    def locator(self, selector):
        return Locator(self, 'password' if selector.startswith('input') else 'content')

    def screenshot(self, **kwargs):
        return b'bad' if self.mode == 'bad-image' else b'\x89PNG\r\n\x1a\n' + b'generic-test-image-not-installed-proof' * 3


class BrowserTests(unittest.TestCase):
    def capture(self, page, sink):
        return capture_bookstack_page(page, origin='https://bookstack.example.invalid',
                                     relative_path='/books/synthetic-book/page/synthetic-page',
                                     title='Retained case', marker='retained-document-case updated and reopened', sink=sink)

    def test_actual_populated_capture_still_requires_review(self):
        images = []
        result = self.capture(Browser(), lambda data: images.append(data) or 'public-synthetic/capture-1')
        self.assertEqual(len(images), 1)
        self.assertTrue(result['review_required'])
        self.assertEqual(len(result['sha256']), 64)
        self.assertEqual(result['category'], 'real-populated-authenticated-capability')

    def test_screenshot_reference_must_not_be_url_or_credential_query(self):
        for reference in ['https://private.invalid/image?token=generic', '../outside', 'image?session=generic']:
            with self.assertRaises(WorkflowError):
                self.capture(Browser(), lambda data: reference)

    def test_login_setup_old_content_and_invalid_screenshots_rejected(self):
        for mode in ['login', 'redirect', 'missing-heading', 'wrong-content', 'bad-image']:
            with self.subTest(mode=mode):
                images = []
                with self.assertRaises(WorkflowError):
                    self.capture(Browser(mode), lambda data: images.append(data) or 'evidence')
                self.assertFalse(images)


REPO_ID = '11111111-2222-3333-4444-555555555555'


class Seafile:
    def __init__(self, mode='ok'):
        self.mode, self.calls, self.content, self.deleted = mode, [], None, False

    def request(self, method, path, *, payload=None, timeout):
        self.calls.append((method, path))
        root = '/api2/repos/' + REPO_ID
        if method == 'POST' and path == '/api2/repos/':
            return SimpleNamespace(status=200, data={'repo_id': REPO_ID, 'repo_name':
                                   'Unrelated library' if self.mode == 'wrong-name' else payload['name']})
        if path == root + '/upload-link/?p=/':
            host = 'foreign.invalid' if self.mode == 'foreign-upload' else 'seafile.example.invalid'
            return SimpleNamespace(status=200, data='https://' + host + '/seafhttp/upload-api/generic-fixture')
        if path == root + '/file/?p=/proof.txt&reuse=1':
            host = 'foreign.invalid' if self.mode == 'foreign-download' else 'seafile.example.invalid'
            return SimpleNamespace(status=200, data='https://' + host + '/seafhttp/files/generic-fixture/proof.txt')
        if path == '/seafhttp/files/generic-fixture/proof.txt':
            return SimpleNamespace(status=302 if self.mode == 'redirect-download' else 200,
                                   body=b'wrong' if self.mode == 'wrong-bytes' else self.content)
        if method == 'DELETE' and path == root + '/':
            self.deleted = True
            return SimpleNamespace(status=204, data=None)
        if method == 'GET' and path == root + '/':
            return SimpleNamespace(status=404 if self.deleted else 200, data=None)
        raise AssertionError('unexpected fake Seafile request')

    def upload(self, path, *, filename, content, timeout):
        self.calls.append(('UPLOAD', path))
        assert path == '/seafhttp/upload-api/generic-fixture?ret-json=1'
        self.content = content
        return SimpleNamespace(status=200, data=[{'name': filename, 'size': len(content),
                                                  'id': '1'*40}])


class SeafileTests(unittest.TestCase):
    def run_workflow(self, fake):
        return seafile_roundtrip(fake, origin='https://seafile.example.invalid', run_id='case', budget=budget())

    def test_actual_file_bytes_and_owned_library_cleanup(self):
        fake = Seafile()
        result = self.run_workflow(fake)
        self.assertEqual(fake.content, b'retained-file-case-42\n')
        self.assertTrue(fake.deleted)
        self.assertFalse(result['onlyoffice_edit_verified'])
        self.assertNotIn('generic-fixture', repr(result))
        self.assertEqual(fake.calls[-2:], [('DELETE', '/api2/repos/' + REPO_ID + '/'),
                                          ('GET', '/api2/repos/' + REPO_ID + '/')])

    def test_foreign_transfer_redirect_or_wrong_bytes_cannot_pass(self):
        for mode in ['foreign-upload', 'foreign-download', 'redirect-download', 'wrong-bytes']:
            with self.subTest(mode=mode):
                fake = Seafile(mode)
                with self.assertRaises(WorkflowError):
                    self.run_workflow(fake)
                self.assertTrue(fake.deleted)
                self.assertFalse(any('foreign.invalid' in path for _, path in fake.calls))

    def test_unverified_library_name_never_deleted(self):
        fake = Seafile('wrong-name')
        with self.assertRaises(WorkflowError):
            self.run_workflow(fake)
        self.assertFalse(fake.deleted)
        self.assertEqual(len(fake.calls), 1)


if __name__ == '__main__':
    unittest.main()
