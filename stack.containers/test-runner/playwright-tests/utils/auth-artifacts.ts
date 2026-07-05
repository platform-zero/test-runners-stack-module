import * as fs from 'fs';
import * as path from 'path';
import type { TestUser, UserProfile } from './test-user';

export type BrowserTestUser = TestUser & {
  stackAdminProfile?: UserProfile | null;
};

export type StackAdminCredentials = {
  username: string;
  password: string;
  email: string;
};

const MANAGED_USER_REGISTRY = 'managed-test-users.json';

function normalizedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function authDirCandidates(): string[] {
  return [
    process.env.PLAYWRIGHT_AUTH_DIR,
    '/app/playwright-tests/.auth',
    path.resolve(process.cwd(), '.auth'),
    path.resolve(__dirname, '../.auth'),
  ].filter((candidate): candidate is string => Boolean(candidate && candidate.trim().length > 0));
}

export function resolveAuthDir(): string {
  for (const candidate of authDirCandidates()) {
    const parent = path.dirname(candidate);
    if (fs.existsSync(candidate) || fs.existsSync(parent)) {
      return candidate;
    }
  }

  return path.resolve(__dirname, '../.auth');
}

export function ensureAuthDir(): string {
  const authDir = resolveAuthDir();
  fs.mkdirSync(authDir, { recursive: true });
  return authDir;
}

export function authArtifactPath(fileName: string): string {
  return path.join(resolveAuthDir(), fileName);
}

export function resolveExistingAuthArtifact(fileName: string): string | null {
  for (const authDir of authDirCandidates()) {
    const candidate = path.join(authDir, fileName);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

export function requireAuthArtifact(fileName: string): string {
  const existingPath = resolveExistingAuthArtifact(fileName);
  if (!existingPath) {
    throw new Error(`Required Playwright auth artifact is missing: ${fileName}`);
  }
  return existingPath;
}

export function writeJsonAuthArtifact(fileName: string, value: unknown): string {
  const outputPath = path.join(ensureAuthDir(), fileName);
  fs.writeFileSync(outputPath, JSON.stringify(value, null, 2));
  return outputPath;
}

function normalizeUsernames(usernames: Iterable<string>): string[] {
  return [...new Set(
    [...usernames]
      .map((username) => normalizedString(username).toLowerCase())
      .filter((username) => username.length > 0)
  )].sort();
}

export function loadManagedTestUserRegistry(): string[] {
  const registryPath = resolveExistingAuthArtifact(MANAGED_USER_REGISTRY);
  if (!registryPath) {
    return [];
  }

  try {
    const value = JSON.parse(fs.readFileSync(registryPath, 'utf-8')) as unknown;
    if (!Array.isArray(value)) {
      return [];
    }
    return normalizeUsernames(value.filter((entry): entry is string => typeof entry === 'string'));
  } catch {
    return [];
  }
}

export function writeManagedTestUserRegistry(usernames: Iterable<string>): string {
  return writeJsonAuthArtifact(MANAGED_USER_REGISTRY, normalizeUsernames(usernames));
}

export function registerManagedTestUser(username: string): string[] {
  const usernames = loadManagedTestUserRegistry();
  usernames.push(username);
  writeManagedTestUserRegistry(usernames);
  return loadManagedTestUserRegistry();
}

export function unregisterManagedTestUser(username: string): string[] {
  const normalized = normalizedString(username).toLowerCase();
  if (!normalized) {
    return loadManagedTestUserRegistry();
  }

  const remaining = loadManagedTestUserRegistry().filter((entry) => entry !== normalized);
  writeManagedTestUserRegistry(remaining);
  return remaining;
}

function readJsonArtifact<T>(fileName: string): T {
  const artifactPath = requireAuthArtifact(fileName);
  return JSON.parse(fs.readFileSync(artifactPath, 'utf-8')) as T;
}

export function tryLoadTestUser(): BrowserTestUser | null {
  const artifactPath = resolveExistingAuthArtifact('test-user.json');
  if (!artifactPath) {
    return null;
  }

  return JSON.parse(fs.readFileSync(artifactPath, 'utf-8')) as BrowserTestUser;
}

export function loadTestUser(): BrowserTestUser {
  const user = readJsonArtifact<BrowserTestUser>('test-user.json');
  if (!normalizedString(user.username)) {
    throw new Error('Playwright test-user.json is missing username');
  }
  if (!normalizedString(user.password)) {
    throw new Error('Playwright test-user.json is missing password');
  }
  return user;
}

export function lazyTestUser(): BrowserTestUser {
  return new Proxy({} as BrowserTestUser, {
    get(_target, property) {
      const loadedUser = loadTestUser() as unknown as Record<PropertyKey, unknown>;
      return loadedUser[property];
    },
  });
}

export function resolveStackAdminCredentials(): StackAdminCredentials | null {
  const testUser = tryLoadTestUser();
  const username =
    normalizedString(testUser?.stackAdminProfile?.username)
    || normalizedString(process.env.STACK_ADMIN_USER);
  const password = normalizedString(process.env.STACK_ADMIN_PASSWORD);

  if (!username || !password) {
    return null;
  }

  return {
    username,
    password,
    email:
      normalizedString(testUser?.stackAdminProfile?.email)
      || normalizedString(process.env.STACK_ADMIN_EMAIL),
  };
}

export function requireStackAdminCredentials(context: string): StackAdminCredentials {
  const credentials = resolveStackAdminCredentials();
  if (!credentials) {
    throw new Error(`${context} requires STACK_ADMIN_USER and STACK_ADMIN_PASSWORD.`);
  }
  return credentials;
}
