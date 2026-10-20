"""Retained BookStack real CRUD/search and populated browser evidence adapters.

No endpoint/client creation, credentials, filesystem reads or installed claims.
Only lead-allocated disposable API user/book namespace and synthetic content.
"""
import hashlib
import re
import uuid
from urllib.parse import quote, urlsplit

from native_workflows import Budget, WorkflowError, identifier, require


def request(transport, budget, method, path, *, payload=None, statuses=(200,)):
    try:
        response = transport.request(method, path, payload=payload, timeout=budget.left())
    except Exception:
        raise WorkflowError('document transport failed (details withheld)') from None
    require(response.status in statuses, 'document API status rejected (auth/redirect/error is not capability)')
    return response.data


def native_id(model):
    value = model.get('id')
    require(type(value) is int and value > 0, 'invalid created document resource id')
    return value


def page_matches(model, *, page_id, book_id, name, markdown):
    require(isinstance(model, dict) and model.get('id') == page_id and model.get('book_id') == book_id
            and model.get('name') == name and model.get('markdown') == markdown,
            'BookStack persisted page content/ownership mismatch')


def bookstack_document(transport, *, run_id=None, budget=None, capture=None):
    """Create book/page -> read -> update -> read/search -> optional browser capture.

    capture(relative_path, title, synthetic_marker) must inspect the actual browser
    page and return a generic evidence reference. Callback runs BEFORE cleanup.
    Owned page/book are deleted on success/failure with a separate bounded budget.
    """
    budget = budget or Budget()
    run_id = identifier(run_id or uuid.uuid4().hex)
    name, marker = 'Retained ' + run_id, 'retained-document-' + run_id
    initial = '# Synthetic retained capability\n\n' + marker + ' initial\n'
    updated = '# Synthetic retained capability\n\n' + marker + ' updated and reopened\n'
    book_id, page_id, evidence = None, None, None
    try:
        book = request(transport, budget, 'POST', '/api/books', statuses=(200, 201),
                       payload={'name': name, 'description': 'Disposable synthetic retained acceptance'})
        require(book.get('name') == name, 'created book name mismatch')
        book_id = native_id(book)
        page = request(transport, budget, 'POST', '/api/pages', statuses=(200, 201),
                       payload={'book_id': book_id, 'name': name, 'markdown': initial})
        require(page.get('book_id') == book_id and page.get('name') == name, 'created page ownership mismatch')
        page_id = native_id(page)
        path = '/api/pages/' + str(page_id)
        page_matches(request(transport, budget, 'GET', path), page_id=page_id, book_id=book_id, name=name, markdown=initial)
        request(transport, budget, 'PUT', path, payload={'name': name, 'markdown': updated})
        reopened = request(transport, budget, 'GET', path)
        page_matches(reopened, page_id=page_id, book_id=book_id, name=name, markdown=updated)
        # Native search/indexing may lag: bounded retry, never text-only login pass.
        while True:
            results = request(transport, budget, 'GET', '/api/search?query=' + quote(marker, safe=''))
            require(isinstance(results, dict) and isinstance(results.get('data'), list), 'unsupported BookStack search model')
            matches = [r for r in results['data'] if r.get('type') == 'page' and r.get('id') == page_id and r.get('name') == name]
            if matches:
                break
            budget.pause()
        book_slug, page_slug = book.get('slug'), reopened.get('slug')
        require(isinstance(book_slug, str) and isinstance(page_slug, str), 'BookStack browser slugs missing')
        relative_path = '/books/' + identifier(book_slug) + '/page/' + identifier(page_slug)
        if capture:
            evidence = capture(relative_path, name, marker + ' updated and reopened')
        return {'workflow': 'bookstack-create-update-read-search', 'book_id': book_id,
                'page_id': page_id, 'browser_path': relative_path,
                'browser_evidence': evidence, 'proof_class': 'transport-provenance-required'}
    except WorkflowError:
        raise
    except Exception:
        raise WorkflowError('invalid document protocol model (details withheld)') from None
    finally:
        cleanup = Budget(seconds=30, max_polls=30)
        if book_id:
            try:
                if page_id:
                    request(transport, cleanup, 'DELETE', '/api/pages/' + str(page_id), statuses=(200, 204, 404))
                    request(transport, cleanup, 'GET', '/api/pages/' + str(page_id), statuses=(404,))
            finally:
                request(transport, cleanup, 'DELETE', '/api/books/' + str(book_id), statuses=(200, 204, 404))
                request(transport, cleanup, 'GET', '/api/books/' + str(book_id), statuses=(404,))


def capture_bookstack_page(page, *, origin, relative_path, title, marker, sink):
    """Synchronous Playwright-compatible actual populated page capture.

    Caller supplies preauthenticated isolated browser page and private screenshot
    sink(bytes)->generic_reference. No filesystem/default screenshot path. This
    checks content rendered AFTER real API workflow; screenshot still needs review.
    Never use for finance; this is BookStack-specific synthetic public evidence.
    """
    parsed = urlsplit(origin)
    require(parsed.scheme == 'https' and parsed.hostname and not parsed.username and not parsed.password
            and parsed.path in ('', '/') and not parsed.query and not parsed.fragment, 'canonical browser origin required')
    parts = relative_path.split('/')
    require(len(parts) == 5 and parts[1] == 'books' and parts[3] == 'page', 'BookStack page route required')
    identifier(parts[2]); identifier(parts[4])
    try:
        target = origin.rstrip('/') + relative_path
        response = page.goto(target, wait_until='networkidle', timeout=15000)
        require(response is not None and response.status == 200 and page.url == target, 'browser redirected or failed to open actual page')
        heading = page.get_by_role('heading', name=title, exact=True)
        require(heading.count() == 1, 'populated document heading missing/ambiguous')
        heading.wait_for(state='visible', timeout=10000)
        content = page.locator('.page-content')
        require(content.count() == 1 and content.is_visible(), 'actual BookStack page body missing')
        require(marker in content.inner_text(timeout=10000), 'updated synthetic page content not rendered')
        require(not page.locator('input[type="password"]').is_visible(), 'login/setup screenshot rejected')
        image = page.screenshot(full_page=True, type='png', timeout=10000)
        require(isinstance(image, bytes) and image.startswith(b'\x89PNG\r\n\x1a\n') and len(image) > 64,
                'invalid browser screenshot bytes')
        reference = sink(image)
        require(isinstance(reference, str) and bool(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._/-]{0,255}', reference))
                and '..' not in reference.split('/'), 'generic screenshot reference required; no URL/query/credentials')
        return {'category': 'real-populated-authenticated-capability', 'reference': reference,
                'sha256': hashlib.sha256(image).hexdigest(), 'review_required': True,
                'proof_class': 'browser-transport-provenance-required'}
    except WorkflowError:
        raise
    except Exception:
        raise WorkflowError('populated browser capture failed (details withheld)') from None


def _seafile_link(value, origin, prefix):
    """Keep transient file-link tokens inside transport calls, never result/logs."""
    require(isinstance(value, str), 'Seafile transfer link missing')
    expected, actual = urlsplit(origin), urlsplit(value)
    require(expected.scheme == actual.scheme == 'https' and expected.hostname
            and actual.hostname == expected.hostname
            and (actual.port or 443) == (expected.port or 443)
            and not actual.username and not actual.password and not actual.fragment
            and not expected.username and not expected.password
            and expected.path in ('', '/') and not expected.query and not expected.fragment,
            'Seafile transfer link escaped handed-off HTTPS origin')
    require(actual.path.startswith(prefix) and '%' not in actual.path
            and not any(p in ('.', '..') for p in actual.path.split('/'))
            and not any(c in value for c in '\r\n\\\x00'), 'unexpected Seafile transfer route')
    return actual.path + ('?' + actual.query if actual.query else '')


def seafile_roundtrip(transport, *, origin, run_id=None, budget=None):
    """Create own synthetic library; multipart upload/download exact bytes; delete.

    HTTP/native transport implements request(...) and upload(...). Uses Seafile
    api2 repo/upload-link/file-link protocols; file URLs are restricted to the
    handed-off same origin before authenticated transport use. No real files,
    libraries, credentials or old endpoints are read. Does NOT certify OnlyOffice.
    """
    budget = budget or Budget()
    run_id = identifier(run_id or uuid.uuid4().hex)
    library_name, filename = 'Retained ' + run_id, 'proof.txt'
    expected = ('retained-file-' + run_id + '-42\n').encode()
    repo_id, owns_repo = None, False
    try:
        created = request(transport, budget, 'POST', '/api2/repos/', statuses=(200, 201),
                          payload={'name': library_name, 'desc': 'Disposable synthetic retained acceptance'})
        repo_id = created.get('repo_id')
        require(isinstance(repo_id, str) and bool(re.fullmatch(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}', repo_id)),
                'invalid newly created Seafile library id')
        require(created.get('repo_name') == library_name, 'created Seafile library name mismatch')
        owns_repo = True
        root = '/api2/repos/' + repo_id
        link = request(transport, budget, 'GET', root + '/upload-link/?p=/')
        upload_path = _seafile_link(link, origin, '/seafhttp/upload-api/')
        upload_path += ('&' if '?' in upload_path else '?') + 'ret-json=1'
        try:
            uploaded = transport.upload(upload_path, filename=filename, content=expected, timeout=budget.left())
        except Exception:
            raise WorkflowError('Seafile multipart upload failed (details withheld)') from None
        require(uploaded.status == 200 and isinstance(uploaded.data, list) and len(uploaded.data) == 1,
                'Seafile upload did not return one native file result')
        item = uploaded.data[0]
        require(item.get('name') == filename and item.get('size') == len(expected)
                and isinstance(item.get('id'), str) and bool(re.fullmatch('[0-9a-f]{40}', item['id'])),
                'Seafile uploaded filename/size/native object mismatch')
        link = request(transport, budget, 'GET', root + '/file/?p=/proof.txt&reuse=1')
        download_path = _seafile_link(link, origin, '/seafhttp/files/')
        downloaded = transport.request('GET', download_path, timeout=budget.left())
        require(downloaded.status == 200 and downloaded.body == expected,
                'Seafile downloaded bytes do not match uploaded synthetic content')
        return {'workflow': 'seafile-library-upload-download', 'synthetic_library_id': repo_id,
                'filename': filename, 'sha256': hashlib.sha256(expected).hexdigest(),
                'proof_class': 'transport-provenance-required', 'onlyoffice_edit_verified': False}
    except WorkflowError:
        raise
    except Exception:
        raise WorkflowError('invalid Seafile protocol model (details withheld)') from None
    finally:
        if owns_repo:
            cleanup = Budget(seconds=30, max_polls=30)
            request(transport, cleanup, 'DELETE', '/api2/repos/' + repo_id + '/', statuses=(200, 204, 404))
            request(transport, cleanup, 'GET', '/api2/repos/' + repo_id + '/', statuses=(404,))
