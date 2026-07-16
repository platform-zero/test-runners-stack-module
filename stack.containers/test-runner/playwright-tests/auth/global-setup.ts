import { chromium, FullConfig, type Page, type Response } from '@playwright/test';
import { authArtifactPath, writeJsonAuthArtifact } from '../utils/auth-artifacts';
import { removeJupyterContainersForUsers } from '../utils/jupyterhub-cleanup';
import { KeycloakClient } from '../utils/keycloak-client';
import { defaultIdentityProvider } from '../utils/identity-provider';
import { serviceUrl, stackDomain } from '../utils/stack-urls';
import { redactUrlForLogs } from '../utils/telemetry';
import { KeycloakLoginPage } from '../pages/KeycloakLoginPage';

function chromiumHostResolverRules(): string[] {
  const originBypassHost = process.env.PLAYWRIGHT_ORIGIN_BYPASS_HOST?.trim();
  if (!originBypassHost) {
    return [];
  }

  return [
    `MAP ${stackDomain} ${originBypassHost}`,
    `MAP *.${stackDomain} ${originBypassHost}`,
  ];
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (value) {
    return value;
  }

  throw new Error(
    `Missing ${name}. Deploy the built bundle and run through ./run-tests.sh, or export STACK_RUNTIME_ENV_FILE=/path/to/runtime/stack.env before direct Playwright usage.`
  );
}

async function gotoIdentityProvider(page: Page, providerUrl: string): Promise<Response | null> {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await page.goto(providerUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const transient = /ERR_NETWORK_CHANGED|ERR_SSL_PROTOCOL_ERROR|ERR_CONNECTION_(?:RESET|CLOSED|REFUSED)/i.test(message);
      if (!transient || attempt === maxAttempts) {
        throw error;
      }
      console.log(`   Transient identity-provider navigation failure; retrying (${attempt}/${maxAttempts})...`);
      await page.waitForTimeout(500 * attempt);
    }
  }
  throw new Error('Identity-provider navigation retry loop exhausted unexpectedly.');
}

async function globalSetup(_config: FullConfig) {
  if (process.env.PW_SKIP_GLOBAL_SETUP === '1') {
    console.log('Skipping Playwright global setup because PW_SKIP_GLOBAL_SETUP=1');
    return;
  }

  await keycloakGlobalSetup();
}

async function keycloakGlobalSetup() {
  const identityProvider = defaultIdentityProvider;
  console.log('\nPlaywright Global Setup - Keycloak User Provisioning\n');

  const keycloakClient = KeycloakClient.fromEnvironment();
  const stackAdminUser = requireEnv('STACK_ADMIN_USER');
  const domain = stackDomain;
  const username = KeycloakClient.generateUsername('playwright');
  const email = `${username}@${domain}`;
  let testUser = KeycloakClient.buildManagedUser(username, email);
  if (/^visual(?:-|$)/i.test((process.env.PLAYWRIGHT_RUN_LABEL || '').trim())) {
    testUser = {
      ...testUser,
      groups: [...new Set([...testUser.groups, 'admins'])],
    };
  }

  console.log('Test User Details:');
  console.log(`   Username: ${username}`);
  console.log(`   Email:    ${email}`);
  console.log(`   Groups:   ${testUser.groups.join(', ')}`);
  console.log();

  const removedStaleUsers = await keycloakClient.cleanupManagedTestUsers([stackAdminUser]);
  if (removedStaleUsers.length > 0) {
    const removedJupyterContainers = removeJupyterContainersForUsers(removedStaleUsers);
    console.log(`Removed stale managed Keycloak users: ${removedStaleUsers.join(', ')}`);
    if (removedJupyterContainers.length > 0) {
      console.log(`Removed stale Jupyter notebook containers: ${removedJupyterContainers.join(', ')}`);
    }
    console.log();
  }

  testUser = await keycloakClient.createManagedUser(testUser);
  const liveProfile = await keycloakClient.getUserProfile(testUser.username);
  if (!liveProfile) {
    throw new Error(`Keycloak test user '${testUser.username}' was not readable after provisioning.`);
  }

  testUser = {
    ...testUser,
    email: liveProfile.email,
    givenName: liveProfile.givenName,
    familyName: liveProfile.familyName,
    commonName: liveProfile.commonName,
    displayName: liveProfile.displayName,
    fullName: liveProfile.fullName,
  };

  const stackAdminProfile = await keycloakClient.getUserProfile(stackAdminUser).catch(() => null);
  if (stackAdminProfile) {
    console.log('Stack admin Keycloak identity available for OIDC assertions:');
    console.log(`   username:    ${stackAdminProfile.username}`);
    console.log(`   displayName: ${stackAdminProfile.displayName}`);
    console.log(`   mail:        ${stackAdminProfile.email}`);
    console.log();

    testUser = {
      ...testUser,
      stackAdminProfile,
    };
  }

  const credsPath = writeJsonAuthArtifact('test-user.json', testUser);
  console.log(`Credentials saved to: ${credsPath}`);
  console.log(`Authenticating with ${identityProvider.label}...`);

  const browser = await launchChromiumWithRetry();
  const ignoreHttpsErrors = process.env.PLAYWRIGHT_IGNORE_HTTPS_ERRORS === 'true';
  const context = await browser.newContext({
    ignoreHTTPSErrors: ignoreHttpsErrors,
    bypassCSP: true,
    acceptDownloads: false,
  });
  const page = await context.newPage();
  const protectedUrl = serviceUrl('keycloak-whoami');

  try {
    const providerUrl = identityProvider.authUrl(protectedUrl);
    console.log(`   Connecting to ${identityProvider.label}: ${redactUrlForLogs(providerUrl)}`);
    const response = await gotoIdentityProvider(page, providerUrl);
    console.log(`   Response status: ${response?.status()}`);
    console.log(`   Current URL: ${redactUrlForLogs(page.url())}`);
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {
      console.log('   Network idle timeout, continuing...');
    });

    if (!identityProvider.isAuthUrl(page.url())) {
      await page.screenshot({ path: `test-results/no-${identityProvider.id}-redirect.png`, fullPage: true });
      throw new Error(`Forward auth redirect to ${identityProvider.label} did not occur; current URL=${redactUrlForLogs(page.url())}`);
    }

    const keycloakLogin = new KeycloakLoginPage(page);
    await keycloakLogin.login(testUser.username, testUser.password);
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    if (identityProvider.isAuthUrl(page.url())) {
      throw new Error(`Keycloak login did not leave the auth boundary; current URL=${redactUrlForLogs(page.url())}`);
    }

    const bodyText = (await page.textContent('body').catch(() => '')) || '';
    if (!bodyText.includes(testUser.username)) {
      throw new Error(`Keycloak protected route did not include authenticated username; body=${bodyText.slice(0, 300)}`);
    }

    const storageStatePath = authArtifactPath(identityProvider.sessionArtifactName);
    await context.storageState({ path: storageStatePath });
    console.log(`Auth state saved to: ${storageStatePath}`);
  } catch (error) {
    console.error('Authentication failed:', error);
    await page.screenshot({ path: 'test-results/auth-failure.png', fullPage: true });
    throw error;
  } finally {
    await browser.close();
  }

  console.log('Keycloak global setup complete.');
}

async function launchChromiumWithRetry() {
  const hostResolverRules = chromiumHostResolverRules();
  const launchArgs = {
    args: [
      '--disable-features=IsolateOrigins,site-per-process',
      '--disable-gpu',
      ...(process.env.PLAYWRIGHT_IGNORE_HTTPS_ERRORS === 'true' ? ['--ignore-certificate-errors'] : []),
      ...(hostResolverRules.length > 0 ? [`--host-resolver-rules=${hostResolverRules.join(',')}`] : []),
    ],
  };

  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      if (attempt > 1) {
        console.log(`Chromium launch retry ${attempt}/2...`);
      }
      return await chromium.launch(launchArgs);
    } catch (error) {
      lastError = error;
      const message = String((error as Error)?.message || error);
      const recoverable =
        message.includes('Target page, context or browser has been closed') ||
        message.includes('SIGSEGV') ||
        message.includes('browserType.launch');
      if (!recoverable || attempt === 2) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  throw lastError;
}

export default globalSetup;
