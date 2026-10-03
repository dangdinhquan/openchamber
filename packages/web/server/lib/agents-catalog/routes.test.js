import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import { registerAgentsCatalogRoutes } from './routes.js';

const startApp = (overrides = {}) => {
  const app = express();
  app.use(express.json());
  const calls = [];
  registerAgentsCatalogRoutes(app, {
    AGENT_SCOPE: { USER: 'user' },
    getProfile: (id) => id === 'ssh-profile' ? { sshKey: '/tmp/id_ed25519' } : null,
    scanAgentsRepository: async (input) => {
      calls.push(['scan', input]);
      return { ok: true, normalizedRepo: 'owner/repo', subpath: 'agents', items: [], skippedFiles: 0 };
    },
    readAgentFromRepository: async (input) => {
      calls.push(['read', input]);
      return { ok: true, name: 'reviewer', config: { description: 'Review code', system: 'Review.' } };
    },
    createAgent: (name, config, directory, scope) => {
      calls.push(['create', name, config, directory, scope]);
      return { path: '/home/user/.config/opencode/agents/reviewer.md' };
    },
    ...overrides,
  });

  const server = app.listen(0);
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    calls,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    }),
  };
};

describe('agents catalog routes', () => {
  /** @type {{ close: () => Promise<void> } | null} */
  let appHandle = null;

  afterEach(async () => {
    if (appHandle) {
      await appHandle.close();
      appHandle = null;
    }
  });

  it('scans the requested repository path with the selected SSH identity', async () => {
    appHandle = startApp();
    const response = await fetch(`${appHandle.baseUrl}/api/config/agents-catalog/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'owner/repo', path: 'agents', ref: 'main', gitIdentityId: 'ssh-profile' }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, normalizedRepo: 'owner/repo' });
    expect(appHandle.calls[0]).toEqual(['scan', {
      source: 'owner/repo',
      subpath: 'agents',
      ref: 'main',
      identity: { sshKey: '/tmp/id_ed25519' },
    }]);
  });

  it('installs as a user-scoped agent without overwriting an existing one', async () => {
    appHandle = startApp();
    const response = await fetch(`${appHandle.baseUrl}/api/config/agents-catalog/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'owner/repo', path: 'agents', ref: '', agentPath: 'agents/reviewer.md' }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, name: 'reviewer' });
    expect(appHandle.calls[1]).toEqual(['create', 'reviewer', {
      description: 'Review code',
      system: 'Review.',
    }, null, 'user']);
  });

  it('returns a conflict when OpenCode already has the agent', async () => {
    appHandle = startApp({
      createAgent: () => {
        throw new Error('Agent reviewer already exists as user-level .md file');
      },
    });
    const response = await fetch(`${appHandle.baseUrl}/api/config/agents-catalog/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'owner/repo', path: 'agents', agentPath: 'agents/reviewer.md' }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ ok: false, error: { kind: 'conflict' } });
  });

  it('rejects unknown Git identities before scanning', async () => {
    appHandle = startApp();
    const response = await fetch(`${appHandle.baseUrl}/api/config/agents-catalog/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'owner/repo', gitIdentityId: 'missing' }),
    });

    expect(response.status).toBe(400);
    expect(appHandle.calls).toEqual([]);
  });
});
