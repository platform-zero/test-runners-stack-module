import { KeycloakClient } from '../../utils/keycloak-client';
import * as authArtifacts from '../../utils/auth-artifacts';

describe('KeycloakClient', () => {
  const originalEnv = process.env;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    process.env = { ...originalEnv };
    fetchMock = jest.fn();
    global.fetch = fetchMock as never;
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  it('builds managed browser users without required-action migration state', () => {
    const user = KeycloakClient.buildManagedUser('playwright-demo', 'playwright-demo@example.test');

    expect(user.provider).toBe('keycloak');
    expect(user.username).toBe('playwright-demo');
    expect(user.email).toBe('playwright-demo@example.test');
    expect(user.groups).toEqual(['users', 'operators']);
    expect(user.managed).toBe(true);
    expect(user.password).toMatch(/^PW-/);
  });

  it('creates clients from the runtime environment', () => {
    process.env.KEYCLOAK_INTERNAL_URL = 'http://keycloak:8080/';
    process.env.KEYCLOAK_REALM = 'webservices';
    process.env.KEYCLOAK_ADMIN_USER = 'admin';
    process.env.KEYCLOAK_ADMIN_PASSWORD = 'secret';

    const client = KeycloakClient.fromEnvironment();

    expect(client.baseUrl).toBe('http://keycloak:8080');
    expect(client.realm).toBe('webservices');
  });

  it('creates a managed user through the Keycloak Admin API', async () => {
    const registerSpy = jest.spyOn(authArtifacts, 'registerManagedTestUser').mockReturnValue(['playwright-demo']);
    const client = new KeycloakClient({
      baseUrl: 'http://keycloak:8080',
      realm: 'webservices',
      adminUsername: 'admin',
      adminPassword: 'secret',
    });
    fetchMock
      .mockResolvedValueOnce(okJson({ access_token: 'token' }))
      .mockResolvedValueOnce(okJson([]))
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        headers: { get: () => 'http://keycloak:8080/admin/realms/webservices/users/user-id' },
        text: async () => '',
      });

    const user = await client.createManagedUser(KeycloakClient.buildManagedUser('playwright-demo'));

    expect(user.keycloakUserId).toBe('user-id');
    expect(registerSpy).toHaveBeenCalledWith('playwright-demo');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://keycloak:8080/admin/realms/webservices/users',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"managedBy":["webservices-playwright"]'),
      }),
    );
  });

  it('only cleans up managed playwright users', async () => {
    jest.spyOn(authArtifacts, 'loadManagedTestUserRegistry').mockReturnValue(['ofexample1', 'obexample2']);
    jest.spyOn(authArtifacts, 'unregisterManagedTestUser').mockReturnValue([]);
    const client = new KeycloakClient({
      baseUrl: 'http://keycloak:8080',
      realm: 'webservices',
      adminUsername: 'admin',
      adminPassword: 'secret',
    });
    fetchMock
      .mockResolvedValueOnce(okJson({ access_token: 'token' }))
      .mockResolvedValueOnce(okJson([
        { id: 'managed-id', username: 'plmosm1qtdabc1', attributes: { managed: ['true'], managedBy: ['webservices-playwright'] } },
        { id: 'real-id', username: 'gerald', attributes: { managedBy: ['webservices-playwright'] } },
        { id: 'foreign-id', username: 'playwright-foreign', attributes: { managedBy: ['other'] } },
      ]))
      .mockResolvedValueOnce(okJson([
        { id: 'legacy-id', username: 'playwright-legacy', attributes: { managed: ['true'], managedBy: ['webservices-playwright'] } },
      ]))
      .mockResolvedValueOnce(okJson([
        { id: 'onboard-id', username: 'ofexample1', attributes: { managed: ['true'], managedBy: ['webservices-playwright'] } },
      ]))
      .mockResolvedValueOnce(okJson([
        { id: 'portal-id', username: 'obexample2', attributes: { managed: ['true'], managedBy: ['webservices-playwright'] } },
      ]))
      .mockResolvedValueOnce(okJson([]))
      .mockResolvedValueOnce({ ok: true, status: 204, text: async () => '' })
      .mockResolvedValueOnce({ ok: true, status: 204, text: async () => '' })
      .mockResolvedValueOnce({ ok: true, status: 204, text: async () => '' })
      .mockResolvedValueOnce({ ok: true, status: 204, text: async () => '' });

    const removed = await client.cleanupManagedTestUsers();

    expect(removed).toEqual(['plmosm1qtdabc1', 'playwright-legacy', 'ofexample1', 'obexample2']);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://keycloak:8080/admin/realms/webservices/users/managed-id',
      expect.objectContaining({ method: 'DELETE' }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      'http://keycloak:8080/admin/realms/webservices/users/legacy-id',
      expect.objectContaining({ method: 'DELETE' }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      'http://keycloak:8080/admin/realms/webservices/users/onboard-id',
      expect.objectContaining({ method: 'DELETE' }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      'http://keycloak:8080/admin/realms/webservices/users/portal-id',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('unregisters managed usernames when deleting a Keycloak user', async () => {
    const unregisterSpy = jest.spyOn(authArtifacts, 'unregisterManagedTestUser').mockReturnValue([]);
    const client = new KeycloakClient({
      baseUrl: 'http://keycloak:8080',
      realm: 'webservices',
      adminUsername: 'admin',
      adminPassword: 'secret',
    });
    fetchMock
      .mockResolvedValueOnce(okJson({ access_token: 'token' }))
      .mockResolvedValueOnce(okJson([
        { id: 'managed-id', username: 'playwright-delete-me', email: 'playwright-delete-me@example.test', attributes: {} },
      ]))
      .mockResolvedValueOnce({ ok: true, status: 204, text: async () => '' });

    await client.deleteUser('playwright-delete-me');

    expect(unregisterSpy).toHaveBeenCalledWith('playwright-delete-me');
  });

  it('refreshes the admin token before its declared expiry', async () => {
    const nowSpy = jest.spyOn(Date, 'now');
    nowSpy.mockReturnValueOnce(1_000).mockReturnValueOnce(57_000).mockReturnValueOnce(57_000);
    const client = new KeycloakClient({
      baseUrl: 'http://keycloak:8080',
      realm: 'webservices',
      adminUsername: 'admin',
      adminPassword: 'secret',
    });
    fetchMock
      .mockResolvedValueOnce(okJson({ access_token: 'first-token', expires_in: 60 }))
      .mockResolvedValueOnce(okJson([{ id: 'first', username: 'first-user' }]))
      .mockResolvedValueOnce(okJson({ access_token: 'second-token', expires_in: 60 }))
      .mockResolvedValueOnce(okJson([{ id: 'second', username: 'second-user' }]));

    await client.getUserProfile('first-user');
    await client.getUserProfile('second-user');

    const tokenRequests = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/protocol/openid-connect/token'));
    expect(tokenRequests).toHaveLength(2);
    expect(fetchMock.mock.calls[1][1].headers.authorization).toBe('Bearer first-token');
    expect(fetchMock.mock.calls[3][1].headers.authorization).toBe('Bearer second-token');
  });

  it('generates Planka-compatible managed usernames', () => {
    const username = KeycloakClient.generateUsername('playwright');

    expect(username).toMatch(/^[a-zA-Z0-9]+((_|\.)?[a-zA-Z0-9])*$/);
    expect(username.length).toBeLessThanOrEqual(16);
  });
});

function okJson(value: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => value,
    text: async () => JSON.stringify(value),
  };
}
