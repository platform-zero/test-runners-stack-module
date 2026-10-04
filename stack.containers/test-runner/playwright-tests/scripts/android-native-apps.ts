import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { withManagedBrowserUser } from '../utils/managed-browser-user';
import type { TestUser } from '../utils/test-user';
import { seedInbox, removeSeededMail } from './android-mail-evidence';
import { withForgejoToken } from './android-forgejo-token';
import { withDonetickNativeUser } from './android-donetick-user';

const api = process.argv[2] || '36';
if (api !== '36') throw new Error('native Android app suite requires API 36');
const domain = process.env.DOMAIN || '';
if (!domain) throw new Error('DOMAIN is required');
const endpoint = process.env.ANDROID_APPIUM_ENDPOINT || 'http://android-test-runner-api36:4723';
const lock = JSON.parse(readFileSync('/app/android-apks.lock.json', 'utf8')) as {
  apps: Array<{ id: string; package: string; versionCode: number }>;
};

type WireResponse = { value?: any; sessionId?: string };
const elementKey = 'element-6066-11e4-a52e-4f735466cecf';

async function wire(method: string, path: string, body?: unknown, timeout = 60_000): Promise<WireResponse> {
  const response = await fetch(`${endpoint}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  const data = await response.json() as WireResponse;
  if (!response.ok || (data.value && typeof data.value === 'object' && 'error' in data.value)) {
    throw new Error(`webdriver-command:${method}:${path}:${String(data.value?.error || response.status)}`);
  }
  return data;
}

class AppSession {
  constructor(readonly id: string, readonly session: string) {}

  static async open(id: string): Promise<AppSession> {
    const app = lock.apps.find((entry) => entry.id === id);
    if (!app) throw new Error(`unlocked-app:${id}`);
    let created: WireResponse | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        created = await wire('POST', '/session', {
          capabilities: { alwaysMatch: {
            platformName: 'Android',
            'appium:automationName': 'UiAutomator2',
            'appium:deviceName': 'p0-api36',
            'appium:app': `/artifacts/android-apks/${id}.apk`,
            'appium:appPackage': app.package,
            'appium:appWaitActivity': '*',
            'appium:autoGrantPermissions': true,
            'appium:noReset': false,
            'appium:newCommandTimeout': 1200,
          } },
        }, 180_000);
        break;
      } catch (error) {
        if (attempt === 2 || !/webdriver-command:POST:\/session:(unknown error|session not created)/i.test(String(error))) {
          throw error;
        }
        await delay(3_000 * (attempt + 1));
      }
    }
    if (!created) throw new Error(`session-unavailable:${id}`);
    const session = created.sessionId || created.value?.sessionId;
    if (!session) throw new Error(`session-unavailable:${id}`);
    if (['element', 'homeassistant', 'jellyfin', 'mastodon', 'bitwarden'].includes(id)) {
      await wire('POST', `/session/${session}/execute/sync`, {
        script: 'mobile: terminateApp', args: [{ appId: 'com.android.chrome' }],
      });
      await wire('POST', `/session/${session}/execute/sync`, {
        script: 'mobile: clearApp', args: [{ appId: 'com.android.chrome' }],
      });
    }
    return new AppSession(id, session);
  }

  async close(): Promise<void> {
    await wire('DELETE', `/session/${this.session}`).catch(() => undefined);
  }

  async source(): Promise<string> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        return String((await wire('GET', `/session/${this.session}/source`)).value || '');
      } catch (error) {
        if (attempt === 7 || !/unknown error|no such window/.test(String(error))) throw error;
        await delay(1_000);
      }
    }
    throw new Error(`ui-source-unavailable:${this.id}`);
  }

  async findByText(pattern: RegExp, timeout = 20_000): Promise<string | null> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const source = await this.source();
      const matches: Array<{ attribute: string; label: string; className: string; clickable: boolean }> = [];
      for (const tag of source.match(/<[^>]+>/g) || []) {
        for (const attribute of ['text', 'content-desc', 'resource-id']) {
          const encoded = tag.match(new RegExp(`${attribute}="([^"]*)"`))?.[1];
          if (!encoded) continue;
          const label = encoded.replace(/&quot;/g, '"').replace(/&apos;/g, "'")
            .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
          if (!pattern.test(label)) continue;
          matches.push({
            attribute, label,
            className: tag.match(/class="([^"]*)"/)?.[1] || '',
            clickable: /clickable="true"/.test(tag),
          });
        }
      }
      matches.sort((a, b) => Number(b.clickable) - Number(a.clickable));
      for (const match of matches) {
        const selector = `//*[@${match.attribute}=${xpathLiteral(match.label)} and @class=${xpathLiteral(match.className)}]`;
        try {
          const result = await wire('POST', `/session/${this.session}/element`, {
            using: 'xpath', value: selector,
          });
          const id = result.value?.[elementKey] || result.value?.ELEMENT;
          if (id) return id;
        } catch { /* UI changed between the source snapshot and locator request */ }
      }
      await delay(750);
    }
    return null;
  }

  async tapSuggestion(label: string): Promise<void> {
    const selector = `//*[@text=${xpathLiteral(label)} and @class!='android.widget.EditText']`;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        const result = await wire('POST', `/session/${this.session}/element`, {
          using: 'xpath', value: selector,
        });
        const id = result.value?.[elementKey] || result.value?.ELEMENT;
        if (id) {
          await wire('POST', `/session/${this.session}/element/${id}/click`, {});
          return;
        }
      } catch { /* suggestion is still loading */ }
      await delay(750);
    }
    throw new Error(`ui-control-missing:${this.id}:server-suggestion`);
  }

  async tap(pattern: RegExp, timeout = 20_000): Promise<void> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const id = await this.findByText(pattern, Math.min(3_000, deadline - Date.now()));
      if (!id) continue;
      try {
        await wire('POST', `/session/${this.session}/element/${id}/click`, {});
        return;
      } catch (error) {
        if (!/stale element reference|no such element/.test(String(error))) throw error;
      }
    }
    throw new Error(`ui-control-missing:${this.id}:${pattern.source}`);
  }

  async tapIfVisible(pattern: RegExp, timeout = 3_000): Promise<boolean> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const id = await this.findByText(pattern, Math.min(1_000, deadline - Date.now()));
      if (!id) continue;
      try {
        await wire('POST', `/session/${this.session}/element/${id}/click`, {});
        return true;
      } catch (error) {
        if (!/stale element reference|no such element/.test(String(error))) throw error;
      }
    }
    return false;
  }

  async fill(pattern: RegExp, value: string): Promise<void> {
    const id = await this.findByText(pattern);
    if (!id) throw new Error(`ui-input-missing:${this.id}:${pattern.source}`);
    await this.replaceValue(id, value);
  }

  async input(index: number, value: string): Promise<void> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const id = await this.findInput(index);
      try {
        await this.replaceValue(id, value);
        return;
      } catch (error) {
        if (!/stale element reference|no such element/.test(String(error))) throw error;
      }
    }
    throw new Error(`ui-input-stale:${this.id}:${index}`);
  }

  private async findInput(index: number, timeout = 20_000): Promise<string> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const result = await wire('POST', `/session/${this.session}/elements`, {
        using: 'class name', value: 'android.widget.EditText',
      });
      const entry = result.value?.[index];
      const id = entry?.[elementKey] || entry?.ELEMENT;
      if (id) return id;
      await delay(750);
    }
    throw new Error(`ui-input-missing:${this.id}:${index}`);
  }

  async tapAt(x: number, y: number): Promise<void> {
    await wire('POST', `/session/${this.session}/execute/sync`, {
      script: 'mobile: clickGesture', args: [{ x, y }],
    });
  }

  async typeKeys(value: string): Promise<void> {
    const actions = [...value].flatMap((character) => [
      { type: 'keyDown', value: character }, { type: 'keyUp', value: character },
    ]);
    await wire('POST', `/session/${this.session}/actions`, {
      actions: [{ type: 'key', id: 'keyboard', actions }],
    });
  }

  async typeInput(index: number, value: string): Promise<void> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const id = await this.findInput(index);
      try {
        await wire('POST', `/session/${this.session}/element/${id}/click`, {});
        await this.typeKeys(value);
        return;
      } catch (error) {
        if (!/stale element reference|no such element/.test(String(error))) throw error;
      }
    }
    throw new Error(`ui-input-stale:${this.id}:${index}`);
  }

  private async replaceValue(id: string, value: string): Promise<void> {
    try {
      await wire('POST', `/session/${this.session}/execute/sync`, {
        script: 'mobile: replaceElementValue', args: [{ elementId: id, text: value }],
      });
    } catch {
      await wire('POST', `/session/${this.session}/element/${id}/clear`, {});
      await wire('POST', `/session/${this.session}/element/${id}/value`, { text: value, value: [...value] });
    }
  }

  async expect(pattern: RegExp, timeout = 30_000): Promise<void> {
    if (!await this.findByText(pattern, timeout)) throw new Error(`ui-evidence-missing:${this.id}:${pattern.source}`);
  }

  async back(): Promise<void> {
    await wire('POST', `/session/${this.session}/back`, {});
  }

  async backUntil(pattern: RegExp): Promise<void> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (pattern.test(await this.source())) return;
      await this.back();
    }
    throw new Error(`ui-navigation-failed:${this.id}:${pattern.source}`);
  }
}

function xpathLiteral(value: string): string {
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"')) return `"${value}"`;
  return `concat(${value.split("'").map((part) => `'${part}'`).join(',"\'",')})`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function dismissChromeFirstRun(app: AppSession): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const xml = await app.source();
    if (/package="com.google.android.gms"/.test(xml)) {
      await app.back();
    } else if (/sign in - google accounts|sign in with ease/i.test(xml)) {
      await app.tap(/^SKIP$/i);
    } else if (/sign in to get your bookmarks|add account to device/i.test(xml)) {
      if (!await app.tapIfVisible(/(?:use|continue) without an account|no thanks|skip/i, 3_000)) {
        await app.back();
      }
    } else if (/forgot email\?|learn more about using your account/i.test(xml)) {
      await app.back();
    } else if (/welcome to chrome|make chrome your own/i.test(xml)) {
      await app.tap(/accept & continue|use without an account|no thanks/i);
    } else {
      return;
    }
    await delay(1_000);
  }
  throw new Error(`chrome-first-run-unresolved:${app.id}`);
}

function elementUiStage(xml: string): string {
  if (/no distributors available|troubleshoot notifications/i.test(xml)) return 'notification-dialog';
  if (/chats|rooms|explore/i.test(xml)) return 'chats';
  if (/finish reset/i.test(xml)) return 'finish-reset';
  if (/yes, reset now/i.test(xml)) return 'confirm-reset';
  if (/continue reset/i.test(xml)) return 'continue-reset';
  if (/can.t confirm/i.test(xml)) return 'identity-recovery';
  if (/import your data|create account/i.test(xml)) return 'account-import';
  if (/continue to element x/i.test(xml)) return 'return-to-app';
  if (/enter your account provider/i.test(xml)) return 'provider-entry';
  if (/username|email/i.test(xml) && /password/i.test(xml)) return 'credentials';
  if (/keycloak|single sign.on|sso/i.test(xml)) return 'sso';
  return 'other';
}

async function keycloakSignIn(app: AppSession, user: TestUser): Promise<void> {
  let previousStage = '';
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await dismissChromeFirstRun(app);
    const xml = await app.source();
    if (app.id === 'element') {
      const stage = elementUiStage(xml);
      if (stage !== previousStage) process.stdout.write(`[android-native] app=element phase=sso stage=${stage}\n`);
      previousStage = stage;
    }
    if (/continue to element x|import your data|confirm your digital identity|chats|rooms|no distributors available|troubleshoot notifications/i.test(xml)) return;
    if (/use without an account/i.test(xml)) {
      if (await app.tapIfVisible(/use without an account/i, 2_000)) continue;
    }
    if (/username|email/i.test(xml) && /password/i.test(xml) &&
        (xml.match(/class="android.widget.EditText"/g) || []).length >= 2) {
      await app.input(0, user.username);
      await app.input(1, user.password || '');
      await app.tap(/sign in|log in|continue/i);
      return;
    }
    if (/(?:sign in|log in) with keycloak|text=\"Keycloak\"/i.test(xml)) {
      await app.tap(/(?:sign in|log in) with keycloak|^Keycloak$/i);
      continue;
    }
    if (/keycloak|single sign.on|sso/i.test(xml)) {
      await app.tapIfVisible(/keycloak|single sign.on|sso/i, 2_000);
    } else {
      await app.tapIfVisible(/sign in|log in|continue/i, 2_000);
    }
    await delay(1_000);
  }
  throw new Error(`auth-form-unavailable:${app.id}`);
}

async function completeElementOnboarding(app: AppSession): Promise<void> {
  const deadline = Date.now() + 150_000;
  let previousStage = '';
  while (Date.now() < deadline) {
    let xml: string;
    try {
      xml = await app.source();
    } catch (error) {
      if (!/webdriver-command:.*unknown error/.test(String(error))) throw error;
      await delay(2_000);
      continue;
    }
    const stage = elementUiStage(xml);
    if (stage !== previousStage) process.stdout.write(`[android-native] app=element phase=onboarding stage=${stage}\n`);
    previousStage = stage;
    if (/chats|rooms|explore/i.test(xml)) return;
    const actions: Array<[RegExp, RegExp]> = [
      [/no distributors available|troubleshoot notifications/i, /^OK$/i],
      [/finish reset/i, /^Finish reset$/i],
      [/yes, reset now/i, /^Yes, reset now$/i],
      [/continue reset/i, /^Continue reset$/i],
      [/can.t confirm/i, /can.t confirm/i],
      [/create account/i, /create account/i],
      [/continue to element x/i, /^Continue$/i],
      [/not now/i, /^Not now$/i],
      [/text="OK"|content-desc="OK"/i, /^OK$/i],
    ];
    const action = actions.find(([visible]) => visible.test(xml));
    if (action) {
      await app.tapIfVisible(action[1], 3_000);
    } else {
      await delay(1_000);
    }
  }
  throw new Error('ui-evidence-missing:element:chats|rooms|explore');
}

async function enterServer(app: AppSession, url: string): Promise<void> {
  await app.tapIfVisible(/add server|connect to server|add account|self.hosted|use your own server/i, 5_000);
  await app.input(0, url);
  await app.tap(/connect|next|continue|save|add server|sign in/i);
}

async function probe(host: string, path = '/'): Promise<void> {
  const response = await fetch(`https://${host}.${domain}${path}`, { redirect: 'manual', signal: AbortSignal.timeout(20_000) });
  if (response.status >= 400) throw new Error(`stack-service-unavailable:${host}:${response.status}`);
}

async function acceptLocalMailCertificate(app: AppSession, nextStage: RegExp): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const source = await app.source();
    if (/certificate error/i.test(source)) {
      await app.tap(/^Advanced$/);
      await app.tap(/accept risk and continue/i);
      continue;
    }
    if (nextStage.test(source)) return;
    await delay(1_000);
  }
  throw new Error('mail-certificate-stage-timeout');
}

function docxContains(document: Uint8Array, marker: string): boolean {
  const directory = mkdtempSync(join(tmpdir(), 'android-onlyoffice-'));
  try {
    const file = join(directory, 'document.docx');
    writeFileSync(file, document);
    const xml = execFileSync('unzip', ['-p', file, 'word/document.xml'], { encoding: 'utf8' });
    return xml.replace(/<[^>]+>/g, '').includes(marker);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function checkApp(id: string, user: TestUser): Promise<void> {
  const app = await AppSession.open(id);
  try {
    switch (id) {
      case 'donetick':
        await withDonetickNativeUser(domain, user, async () => {
          await app.expect(/sign in to your account to continue/i, 30_000);
          await delay(2_000);
          await app.tapAt(985, 295);
          await app.expect(/server url/i);
          await app.input(0, `https://donetick-native.${domain}`);
          await app.tap(/^Save$/);
          await app.expect(/sign in to your account to continue/i, 30_000);
          await app.tapAt(985, 295);
          await app.expect(/server url/i);
          await app.expect(/donetick-native/i);
          await app.tap(/^Save$/);
          await wire('POST', `/session/${app.session}/execute/sync`, {
            script: 'mobile: terminateApp', args: [{ appId: 'com.donetick.app' }],
          });
          await wire('POST', `/session/${app.session}/execute/sync`, {
            script: 'mobile: activateApp', args: [{ appId: 'com.donetick.app' }],
          });
          await delay(5_000);
          if (/ops, something went wrong/i.test(await app.source())) await app.tapAt(540, 1485);
          await app.expect(/sign in to your account to continue/i, 30_000);
          await app.typeInput(0, user.email);
          await app.typeInput(1, user.password || '');
          await app.back();
          await app.tapAt(540, 1545);
          await app.expect(/nothing scheduled|create new chore/i, 60_000);
        });
        break;
      case 'element':
        await app.tap(/sign in manually/i);
        await app.input(0, `matrix.${domain}`);
        await app.tap(/continue/i);
        await app.tapIfVisible(/use without an account/i, 3_000);
        await keycloakSignIn(app, user);
        await completeElementOnboarding(app);
        await probe('matrix', '/_matrix/client/versions');
        break;
      case 'homeassistant': {
        const username = process.env.STACK_ADMIN_USER;
        const password = process.env.STACK_ADMIN_PASSWORD;
        if (!username || !password) throw new Error('homeassistant-credentials-missing');
        await app.tap(/connect to my home/i);
        await app.tap(/enter address manually/i);
        await app.input(0, `https://home-native.${domain}`);
        await app.tap(/^Connect$/);
        await app.tapIfVisible(/home assistant local/i, 15_000);
        await app.input(0, username);
        await app.input(1, password);
        await app.tap(/log in|sign in/i);
        for (let attempt = 0; attempt < 5; attempt += 1) {
          const xml = await app.source();
          if (/how would you like to name this device/i.test(xml)) {
            await app.tap(/^Save$/);
            break;
          }
          await delay(1_000);
        }
        await app.tapIfVisible(/do not allow/i, 15_000);
        await app.expect(/overview|dashboard|settings|devices/i, 60_000);
        await probe('home-native');
        break;
      }
      case 'jellyfin':
        await app.input(0, `https://jellyfin.${domain}`);
        await app.tap(/^Connect$/);
        await app.expect(/sign in with keycloak/i, 60_000);
        await probe('jellyfin', '/System/Info/Public');
        break;
      case 'mastodon':
        await app.tap(/^Log in$/);
        await app.input(0, `mastodon.${domain}`);
        await app.tapSuggestion(`mastodon.${domain}`);
        await app.tap(/^Next$/);
        let keycloakVisible = false;
        for (let attempt = 0; attempt < 30; attempt += 1) {
          await dismissChromeFirstRun(app);
          if (await app.findByText(/^Keycloak$/, 1_000)) {
            keycloakVisible = true;
            break;
          }
          await delay(1_000);
        }
        if (!keycloakVisible) throw new Error('ui-evidence-missing:mastodon:^Keycloak$');
        await probe('mastodon', '/api/v1/instance');
        break;
      case 'seafile': {
        const email = process.env.SEAFILE_USERNAME || process.env.STACK_ADMIN_EMAIL;
        const password = process.env.SEAFILE_PASSWORD || process.env.STACK_ADMIN_PASSWORD;
        if (!email || !password) throw new Error('seafile-credentials-missing');
        const base = `https://files-native.${domain}`;
        const authentication = await fetch(`${base}/api2/auth-token/`, {
          method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ username: email, password }), signal: AbortSignal.timeout(20_000),
        });
        const token = (await authentication.json() as { token?: string }).token;
        if (!authentication.ok || !token) throw new Error(`seafile-api-auth:${authentication.status}`);
        const name = `Android native ${Date.now().toString(36)}`;
        const create = await fetch(`${base}/api2/repos/`, {
          method: 'POST', headers: { authorization: `Token ${token}`, 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ name }), signal: AbortSignal.timeout(20_000),
        });
        const repo = (await create.json() as { repo_id?: string }).repo_id;
        if (!create.ok || !repo) throw new Error(`seafile-fixture-create:${create.status}`);
        try {
          await app.tap(/add account/i);
          await app.tap(/other seafile server/i);
          await app.tap(/^https$/i);
          await app.typeInput(0, `files-native.${domain}`);
          await app.input(1, email);
          await app.input(2, password);
          await app.tap(/^Log In$/);
          await app.expect(new RegExp(name), 60_000);
          const libraries = await fetch(`${base}/api2/repos/`, {
            headers: { authorization: `Token ${token}` }, signal: AbortSignal.timeout(20_000),
          });
          if (!libraries.ok || !(await libraries.text()).includes(name)) {
            throw new Error(`seafile-api-evidence:${libraries.status}`);
          }
        } finally {
          const deleted = await fetch(`${base}/api2/repos/${repo}/`, {
            method: 'DELETE', headers: { authorization: `Token ${token}` }, signal: AbortSignal.timeout(20_000),
          });
          if (!deleted.ok) throw new Error(`seafile-fixture-cleanup:${deleted.status}`);
        }
        break;
      }
      case 'gitnex': {
        await withForgejoToken(domain, user, async (token) => {
          await app.input(0, `forgejo.${domain}`);
          await app.input(1, token);
          await app.tap(/^LOGIN$/);
          await app.tapIfVisible(/^Close$/, 15_000);
          await app.expect(new RegExp(user.username), 60_000);
          await app.expect(/my repositories/i);
          const response = await fetch(`https://forgejo.${domain}/api/v1/user`, {
            headers: { authorization: `token ${token}` }, signal: AbortSignal.timeout(20_000),
          });
          const profile = await response.json() as { login?: string };
          if (!response.ok || profile.login !== user.username) throw new Error(`gitnex-api-evidence:${response.status}`);
        });
        break;
      }
      case 'qbitcontroller': {
        const secret = process.env.MODEL_CONTEXT_PROXY_AUTH_SECRET;
        if (!secret) throw new Error('missing-qbittorrent-native-secret');
        await app.tap(/add server/i);
        await app.input(0, 'Stack qBittorrent');
        await app.input(1, `https://qbittorrent-native.${domain}`);
        await app.tap(/advanced settings/i);
        await app.tap(/^Enabled$/);
        await app.tap(/^Username$/);
        await app.input(0, 'android-test-runner');
        await app.tap(/^OK$/);
        await app.tap(/^Password$/);
        await app.input(0, secret);
        await app.tap(/^OK$/);
        await app.back();
        await app.tap(/test configuration/i);
        await app.expect(/success|connected/i);
        await app.tap(/save/i);
        await app.expect(/northstar-portal-backup\.iso/i);
        const endpoint = `https://qbittorrent-native.${domain}/api/v2/torrents/info`;
        const unauthenticated = await fetch(endpoint, { redirect: 'manual' });
        if (unauthenticated.status !== 401) throw new Error(`qbit-auth-boundary:${unauthenticated.status}`);
        const response = await fetch(endpoint, {
          headers: { authorization: `Basic ${Buffer.from(`android-test-runner:${secret}`).toString('base64')}` },
        });
        if (!response.ok) throw new Error(`qbit-api-read:${response.status}`);
        const torrents = await response.json() as Array<{ name?: string }>;
        if (!torrents.some((torrent) => torrent.name === 'northstar-portal-backup.iso')) {
          throw new Error('qbit-service-evidence-missing');
        }
        break;
      }
      case 'bitwarden':
        await app.tap(/^Log in$/);
        await app.tap(/bitwarden\.com/i);
        await app.tap(/self.hosted/i);
        await app.input(0, `https://vaultwarden.${domain}`);
        await app.tap(/^Save$/);
        await app.input(0, user.email);
        await app.tap(/^Continue$/);
        await keycloakSignIn(app, user);
        await delay(3_000);
        await app.expect(/my vault|vault|folders/i, 60_000);
        await probe('vaultwarden', '/api/config');
        break;
      case 'ntfy': {
        const username = user.username;
        const password = user.password;
        if (!password) throw new Error('ntfy-test-user-credentials-missing');
        const topic = `${user.username.toLowerCase()}_alerts`;
        const marker = `native-ntfy-${Date.now().toString(36)}`;
        const server = `https://ntfy-native.${domain}`;
        await app.tapIfVisible(/dismiss/i, 3_000);
        await app.tap(/more options/i);
        await app.tap(/settings/i);
        await app.tap(/manage users/i);
        await app.tap(/add new user/i);
        await app.input(0, server);
        await app.input(1, username);
        await app.input(2, password);
        await app.tap(/^ADD USER$/);
        await app.backUntil(/Subscribed topics/);
        await app.tapIfVisible(/dismiss/i, 2_000);
        await app.tap(/add subscription/i);
        await app.tap(/use another server/i);
        await app.fill(/Topic name, e.g./i, topic);
        await app.fill(/https:\/\/ntfy\.sh/i, server);
        await app.tap(/^SUBSCRIBE$/);
        await app.expect(new RegExp(topic));
        await app.fill(/type a message here/i, marker);
        await app.tap(/publish message/i);
        await app.expect(new RegExp(marker), 30_000);
        const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
        let found = false;
        let status = 0;
        for (let attempt = 0; attempt < 15; attempt += 1) {
          const response = await fetch(`${server}/${topic}/json?poll=1&since=all`, {
            headers: { authorization }, signal: AbortSignal.timeout(20_000),
          });
          status = response.status;
          if (response.ok && (await response.text()).includes(marker)) {
            found = true;
            break;
          }
          await delay(2_000);
        }
        if (!found) throw new Error(`ntfy-service-evidence-missing:${status}`);
        break;
      }
      case 'davx5': {
        const email = process.env.SOGO_NATIVE_TEST_EMAIL || `android-test@${process.env.MAIL_DOMAIN || domain}`;
        const password = process.env.SOGO_NATIVE_TEST_PASSWORD || process.env.MODEL_CONTEXT_PROXY_AUTH_SECRET;
        if (!email || !password) throw new Error('sogo-native-credentials-missing');
        for (let page = 0; page < 5; page += 1) {
          if (!await app.tapIfVisible(/^Next$/, 3_000)) break;
        }
        await app.tap(/add account/i);
        await app.tap(/advanced login/i);
        await app.tap(/continue/i);
        await app.input(0, `https://sogo.${domain}/SOGo/dav/`);
        await app.input(1, email);
        await app.input(2, password);
        await app.tap(/^Login$/);
        await app.expect(/account name/i, 60_000);
        await app.tap(/^Finish$/i);
        await app.expect(/caldav|carddav|calendar|address book|synchronize|account/i, 60_000);
        const response = await fetch(`https://sogo.${domain}/SOGo/dav/${encodeURIComponent(email)}/`, {
          method: 'PROPFIND',
          headers: {
            authorization: `Basic ${Buffer.from(`${email}:${password}`).toString('base64')}`,
            depth: '1', 'content-type': 'application/xml',
          },
          body: '<d:propfind xmlns:d="DAV:"><d:allprop/></d:propfind>',
          signal: AbortSignal.timeout(20_000),
        });
        if (response.status !== 207 || !/multistatus/i.test(await response.text())) {
          throw new Error(`sogo-dav-evidence-missing:${response.status}`);
        }
        break;
      }
      case 'thunderbird': {
        const email = process.env.STACK_ADMIN_EMAIL;
        const password = process.env.STACK_ADMIN_PASSWORD;
        if (!email || !password) throw new Error('mail-credentials-missing');
        const subject = `Android native Thunderbird ${Date.now().toString(36)}`;
        await seedInbox(domain, email, password, subject);
        try {
          await app.tap(/get started/i);
          await app.tap(/add an email account/i);
          await app.input(0, email);
          await app.tap(/^Next$/);
          await app.expect(/configure manually/i, 60_000);
          await app.tap(/configure manually/i);
          await app.input(1, `mail.${domain}`);
          await app.input(3, '1993');
          await app.input(5, email);
          await app.input(6, password);
          await app.tap(/^Next$/);
          await acceptLocalMailCertificate(app, /outgoing server settings/i);
          await app.input(0, `mail.${domain}`);
          await app.input(4, email);
          await app.input(5, password);
          await app.tap(/^SSL\/TLS$/);
          await app.tap(/^StartTLS$/);
          await app.input(2, '1587');
          await app.tap(/^Next$/);
          await acceptLocalMailCertificate(app, /special folders/i);
          await app.tap(/^Next$/);
          await app.expect(/display options/i);
          await app.input(1, 'Android Connectivity Test');
          await app.tap(/^Next$/);
          await app.expect(/sync options/i);
          await app.tap(/^Next$/);
          await app.expect(/inbox/i, 60_000);
          await app.expect(new RegExp(subject), 60_000);
        } finally {
          await removeSeededMail(domain, email, password, subject);
        }
        break;
      }
      case 'onlyoffice': {
        const email = process.env.SEAFILE_USERNAME || process.env.STACK_ADMIN_EMAIL;
        const password = process.env.SEAFILE_PASSWORD || process.env.STACK_ADMIN_PASSWORD;
        if (!email || !password) throw new Error('seafile-credentials-missing');
        const base = `https://files-native.${domain}`;
        const authorization = `Basic ${Buffer.from(`${email}:${password}`).toString('base64')}`;
        const auth = await fetch(`${base}/api2/auth-token/`, {
          method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ username: email, password }), signal: AbortSignal.timeout(20_000),
        });
        const token = (await auth.json() as { token?: string }).token;
        if (!auth.ok || !token) throw new Error(`seafile-api-auth:${auth.status}`);
        const library = `Android Docs ${Date.now().toString(36)}`;
        const created = await fetch(`${base}/api2/repos/`, {
          method: 'POST', headers: { authorization: `Token ${token}`, 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ name: library }), signal: AbortSignal.timeout(20_000),
        });
        const repo = (await created.json() as { repo_id?: string }).repo_id;
        if (!created.ok || !repo) throw new Error(`onlyoffice-library-create:${created.status}`);
        const filename = `android-docs-${Date.now().toString(36)}.docx`;
        const url = `${base}/seafdav/${encodeURIComponent(library)}/${filename}`;
        try {
          const fixture = readFileSync('/app/playwright-tests/fixtures/seafile-onlyoffice-demo.docx');
          const uploaded = await fetch(url, {
            method: 'PUT', headers: { authorization, 'content-type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
            body: new Uint8Array(fixture), signal: AbortSignal.timeout(30_000),
          });
          if (![200, 201, 204].includes(uploaded.status)) throw new Error(`onlyoffice-webdav-upload:${uploaded.status}`);
          await app.tapIfVisible(/^Skip$/, 5_000);
          await app.tap(/^Clouds$/);
          await app.tap(/^Sign in$/);
          await app.tap(/other webdav storage/i);
          await app.input(0, `${base}/seafdav/`);
          await app.input(1, email);
          await app.input(2, password);
          await app.tap(/^CONNECT$/);
          await app.expect(new RegExp(library), 60_000);
          await app.tap(new RegExp(library));
          await app.expect(new RegExp(filename), 30_000);
          await app.tap(new RegExp(filename));
          await app.expect(/edit|document|northstar/i, 60_000);
          const saved = await fetch(url, { headers: { authorization }, signal: AbortSignal.timeout(20_000) });
          if (!saved.ok || !docxContains(new Uint8Array(await saved.arrayBuffer()), 'STACK ONLYOFFICE OK')) {
            throw new Error(`onlyoffice-native-document-read:${saved.status}`);
          }
        } finally {
          const deleted = await fetch(`${base}/api2/repos/${repo}/`, {
            method: 'DELETE', headers: { authorization: `Token ${token}` }, signal: AbortSignal.timeout(20_000),
          });
          if (!deleted.ok) throw new Error(`onlyoffice-library-cleanup:${deleted.status}`);
        }
        break;
      }
      default:
        throw new Error(`unexpected-app:${id}`);
    }
  } catch (error) {
    if (id === 'element' || id === 'homeassistant') {
      try {
        const screenshot = (await wire('GET', `/session/${app.session}/screenshot`, undefined, 10_000)).value;
        if (typeof screenshot === 'string') {
          mkdirSync('/app/test-results/android-api36', { recursive: true });
          writeFileSync(`/app/test-results/android-api36/${id}-failure.png`, Buffer.from(screenshot, 'base64'));
        }
      } catch { /* retain the original app failure when Appium cannot capture the screen */ }
    }
    throw error;
  } finally {
    await app.close();
  }
}

async function main(): Promise<void> {
  await withManagedBrowserUser('an', async (user) => {
    let failed = 0;
    const filter = process.env.ANDROID_NATIVE_APP_FILTER;
    const apps = filter ? lock.apps.filter((item) => filter.split(',').includes(item.id)) : lock.apps;
    if (!apps.length) throw new Error('android-native-filter-empty');
    for (const item of apps) {
      let failure: unknown;
      let passed = false;
      for (let attempt = 1; attempt <= (item.id === 'element' ? 2 : 1); attempt += 1) {
        try {
          await checkApp(item.id, user);
          passed = true;
          process.stdout.write(`[android-native] app=${item.id} result=pass attempt=${attempt}\n`);
          break;
        } catch (error) {
          failure = error;
          if (item.id === 'element' && attempt === 1 &&
              /webdriver-command:.*unknown error|chrome-first-run-unresolved|ui-control-missing:element:use without an account/i.test(String(error))) {
            process.stdout.write('[android-native] app=element retry=cold-start\n');
            await delay(5_000);
            continue;
          }
          break;
        }
      }
      if (!passed) {
        failed += 1;
        const message = failure instanceof Error ? failure.message : String(failure);
        const category = message.split(':')[0].replace(/[^a-z-]/g, '');
        const detail = /^(ui-control-missing|ui-evidence-missing|ui-input-missing):/.test(message)
          ? ` detail=${message.split(':').slice(2).join(':').replace(/[^a-zA-Z0-9|^$.\-]/g, '_')}`
          : /^[a-z-]+:[0-9]+$/.test(message) ? ` status=${message.split(':')[1]}`
          : message.startsWith('webdriver-command:')
            ? ` op=${message.split(':')[1]}${message.split(':')[2]?.replace(/\/session\/[^/]+/, '/session/{id}')} detail=${message.split(':').at(-1)?.replace(/[^a-zA-Z0-9-]/g, '_')}`
            : '';
        process.stdout.write(`[android-native] app=${item.id} result=${category}${detail}\n`);
      }
    }
    process.stdout.write(`[android-native] total=${apps.length} failed=${failed}\n`);
    if (failed) process.exitCode = 1;
  });
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[android-native] result=${message.split(':')[0].replace(/[^a-z-]/g, '')}\n`);
  process.exitCode = 1;
});
