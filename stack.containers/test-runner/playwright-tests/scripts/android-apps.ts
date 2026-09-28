import { readFileSync } from 'node:fs';
import { browserWuiRoutes, routeUrl } from '../utils/route-catalog';
import { withManagedBrowserUser } from '../utils/managed-browser-user';
import type { TestUser } from '../utils/test-user';

const api = process.argv[2];
const onlyDocs = process.argv[3] === '--only-docs';
if (api !== '34' && api !== '36') {
  process.stderr.write('[android-app] result=invalid-api\n');
  process.exit(2);
}

const endpoint = process.env.ANDROID_APPIUM_ENDPOINT || `http://android-test-runner-api${api}:4723`;
type WireValue = { value?: unknown; sessionId?: string };

async function command(method: string, path: string, body?: unknown, timeout = 30_000): Promise<WireValue> {
  const response = await fetch(`${endpoint}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  const data = await response.json() as WireValue;
  if (!response.ok || (data.value && typeof data.value === 'object' && typeof (data.value as { error?: unknown }).error === 'string')) {
    throw new Error(`webdriver-command:${path}:${String((data.value as { error?: string })?.error || response.status)}`);
  }
  return data;
}

async function ready(): Promise<void> {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    try {
      const status = await command('GET', '/status', undefined, 2_000);
      if (status.value && typeof status.value === 'object' && 'ready' in status.value && status.value.ready) return;
    } catch { /* boot is still in progress */ }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error('appium-unavailable');
}

async function execute(session: string, script: string): Promise<unknown> {
  return (await command('POST', `/session/${session}/execute/sync`, { script, args: [] })).value;
}

async function executeAsync(session: string, script: string, args: unknown[] = []): Promise<any> {
  const result = (await command('POST', `/session/${session}/execute/async`, { script, args }, 90_000)).value;
  if (result && typeof result === 'object' && 'error' in result) {
    throw new Error(`docs-browser:${String((result as { error?: string }).error)}`);
  }
  return result;
}

async function currentUrl(session: string): Promise<string> {
  return String((await command('GET', `/session/${session}/url`)).value || '');
}

async function element(session: string, selector: string): Promise<string | null> {
  try {
    const result = (await command('POST', `/session/${session}/element`, {
      using: 'css selector', value: selector,
    })).value as Record<string, string>;
    return result['element-6066-11e4-a52e-4f735466cecf'] || result.ELEMENT || null;
  } catch { return null; }
}

async function authenticate(session: string, user: TestUser): Promise<void> {
  const username = await element(session, '#username, input[name="username"]');
  const password = await element(session, '#password, input[name="password"]');
  const submit = await element(session, '#kc-login, button[type="submit"]');
  if (!username || !password || !submit || !user.password) throw new Error('auth-form-unavailable');
  for (const [id, value] of [[username, user.username], [password, user.password]]) {
    await command('POST', `/session/${session}/element/${id}/value`, { text: value, value: [...value] });
  }
  await command('POST', `/session/${session}/element/${submit}/click`, {});
}

async function checkOnlyOfficeDocs(session: string, user: TestUser): Promise<void> {
  const origin = `https://seafile.${process.env.DOMAIN}`;
  await command('POST', `/session/${session}/url`, { url: `${origin}/` }, 90_000);
  if ((await currentUrl(session)).includes('keycloak.')) await authenticate(session, user);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if ((await currentUrl(session)).startsWith(origin)) break;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  if (!(await currentUrl(session)).startsWith(origin)) throw new Error('docs-seafile-auth-loop');
  const filename = `android-chrome-docs-${Date.now().toString(36)}.docx`;
  const library = `Android Chrome Docs ${Date.now().toString(36)}`;
  const fixture = readFileSync('/app/playwright-tests/fixtures/seafile-onlyoffice-demo.docx').toString('base64');
  const created = await executeAsync(session, `
    const [name, filename, fixture] = arguments;
    const done = arguments[arguments.length - 1];
    (async () => {
      const csrf = document.cookie.split('; ').find((part) => /^(sf)?csrftoken=/.test(part))?.split('=')[1] || '';
      const headers = { 'X-CSRFToken': decodeURIComponent(csrf) };
      const response = await fetch('/api2/repos/', {
        method: 'POST', credentials: 'same-origin',
        headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ name }),
      });
      if (!response.ok) throw new Error('create:' + response.status);
      const repo = (await response.json()).repo_id;
      if (!repo) throw new Error('repo-id-missing');
      const linkResponse = await fetch('/api2/repos/' + repo + '/upload-link/?p=/', { credentials: 'same-origin' });
      if (!linkResponse.ok) throw new Error('upload-link:' + linkResponse.status);
      const link = (await linkResponse.text()).replace(/^"|"$/g, '');
      const bytes = Uint8Array.from(atob(fixture), (character) => character.charCodeAt(0));
      const form = new FormData();
      form.append('parent_dir', '/');
      form.append('file', new File([bytes], filename, { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }));
      const uploaded = await fetch(link, { method: 'POST', body: form, credentials: 'same-origin' });
      if (!uploaded.ok) throw new Error('upload:' + uploaded.status);
      return { repo };
    })().then(done, (error) => done({ error: String(error) }));
  `, [library, filename, fixture]) as { repo?: string };
  if (!created.repo) throw new Error('docs-repo-missing');
  let checkError: unknown;
  try {
    await command('POST', `/session/${session}/url`, {
      url: `${origin}/lib/${created.repo}/file/${encodeURIComponent(filename)}`,
    }, 90_000);
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const state = await execute(session, `
        const text = document.body?.innerText || '';
        return {
          editor: !!window.DocsAPI || !!document.querySelector('iframe[src*="onlyoffice"], script[src*="onlyoffice"]'),
          error: /mobile web editors.*license|error loading document|document not found/i.test(text),
        };
      `) as { editor?: boolean; error?: boolean };
      if (state.error) throw new Error('docs-mobile-editor-error');
      if (state.editor) return;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    throw new Error('docs-mobile-editor-missing');
  } catch (error) {
    checkError = error;
    throw error;
  } finally {
    const adminEmail = process.env.SEAFILE_USERNAME || process.env.STACK_ADMIN_EMAIL;
    const adminPassword = process.env.SEAFILE_PASSWORD || process.env.STACK_ADMIN_PASSWORD;
    let cleanup = 0;
    if (adminEmail && adminPassword) {
      const base = `https://files-native.${process.env.DOMAIN}`;
      const auth = await fetch(`${base}/api2/auth-token/`, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ username: adminEmail, password: adminPassword }),
        signal: AbortSignal.timeout(20_000),
      }).catch(() => null);
      const token = auth?.ok ? (await auth.json() as { token?: string }).token : undefined;
      if (token) {
        const deleted = await fetch(`${base}/api/v2.1/admin/libraries/${created.repo}/`, {
          method: 'DELETE', headers: { authorization: `Token ${token}` },
          signal: AbortSignal.timeout(20_000),
        }).catch(() => null);
        cleanup = deleted?.status || 0;
      }
    }
    if (cleanup !== 200 && cleanup !== 204) {
      if (checkError) process.stderr.write(`[android-app] docs-library-cleanup=${cleanup}\n`);
      else throw new Error(`docs-library-cleanup-${cleanup}`);
    }
  }
}

function category(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (message.startsWith('docs-')) return message.split(':')[0];
  if (message.startsWith('webdriver-command:')) return message.split(':').slice(0, 3).join(':');
  if (message === 'appium-unavailable') return 'appium-unavailable';
  if (message === 'auth-form-unavailable') return 'auth-form-unavailable';
  if (message === 'empty-page') return 'empty-page';
  if (message === 'browser-error') return 'browser-error';
  if (message === 'auth-loop') return 'auth-loop';
  return 'webdriver-command';
}

async function run(): Promise<void> {
  await ready();
  await withManagedBrowserUser('android', async (user) => {
    const created = await command('POST', '/session', {
      capabilities: { alwaysMatch: {
        platformName: 'Android', 'appium:automationName': 'UiAutomator2',
        'appium:deviceName': `p0-api${api}`, browserName: 'Chrome',
        'appium:chromedriverExecutableDir': '/opt/chromedrivers',
        'appium:chromeOptions': { args: ['--ignore-certificate-errors', '--disable-fre'] },
      } },
    }, 180_000);
    const session = created.sessionId || (created.value as { sessionId?: string })?.sessionId;
    if (!session) throw new Error('session-unavailable');
    let failed = 0;
    try {
      for (const route of onlyDocs ? [] : browserWuiRoutes) {
        let result = 'entry-ready';
        try {
          const entryPath = 'path' in route.anonymous ? route.anonymous.path : undefined;
          const target = routeUrl(route, entryPath || route.path || '/');
          await command('POST', `/session/${session}/url`, { url: target }, 90_000);
          let location = await currentUrl(session);
          if (location.includes('keycloak.') && route.host !== 'keycloak') {
            await authenticate(session, user);
            for (let attempt = 0; attempt < 20; attempt += 1) {
              await new Promise((resolve) => setTimeout(resolve, 1_000));
              location = await currentUrl(session);
              if (!location.includes('keycloak.')) break;
            }
            if (location.includes('keycloak.')) throw new Error('auth-loop');
            result = 'authenticated-entry';
          }
          if (location.startsWith('chrome-error:') || location.startsWith('about:')) throw new Error('browser-error');
          const rendered = await execute(session,
            'return document.readyState !== "loading" && !!document.body && document.body.children.length > 0');
          if (!rendered) throw new Error('empty-page');
        } catch (error) {
          failed += 1;
          result = category(error);
        }
        process.stdout.write(`[android-app] api=${api} route=${route.host} result=${result}\n`);
      }
      if (api === '36') {
        try {
          await checkOnlyOfficeDocs(session, user);
          process.stdout.write('[android-app] api=36 route=onlyoffice-docs-editor result=pass\n');
        } catch (error) {
          failed += 1;
          process.stdout.write(`[android-app] api=36 route=onlyoffice-docs-editor result=${category(error)}\n`);
        }
      }
    } finally {
      await command('DELETE', `/session/${session}`).catch(() => undefined);
    }
    process.stdout.write(`[android-app] api=${api} total=${(onlyDocs ? 0 : browserWuiRoutes.length) + (api === '36' ? 1 : 0)} failed=${failed}\n`);
    if (failed) process.exitCode = 1;
  });
}

run().catch((error) => {
  process.stderr.write(`[android-app] api=${api} result=${category(error)}\n`);
  process.exitCode = 1;
});
