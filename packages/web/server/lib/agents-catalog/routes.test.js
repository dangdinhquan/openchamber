import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { registerAgentsCatalogRoutes } from './routes.js';

const startApp = async (overrides = {}) => {
  const app = express();
  app.use(express.json());
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-agent-catalog-routes-'));
  const calls = [];
  const syncService = await registerAgentsCatalogRoutes(app, {
    AGENT_SCOPE: { USER: 'user' },
    getProfile: (id) => id === 'ssh-profile' ? { sshKey: '/tmp/id_ed25519' } : null,
    getAgentConfig: () => ({ source: 'none', config: {} }),
    scanAgentsRepository: async (input) => {
      calls.push(['scan', input]);
      return {
        ok: true,
        normalizedRepo: 'owner/repo',
        subpath: 'agents',
        items: [],
        definitions: [],
        skippedFiles: 0,
        commit: 'a'.repeat(40),
      };
    },
    readAgentFromRepository: async (input) => {
      calls.push(['read', input]);
      return { ok: true, name: 'reviewer', config: { description: 'Review code', system: 'Review.' } };
    },
    createAgent: (name, config, directory, scope) => {
      calls.push(['create', name, config, directory, scope]);
      return { path: '/home/user/.config/opencode/agents/reviewer.md' };
    },
    deleteAgent: (...args) => calls.push(['delete', ...args]),
    updateAgent: () => {},
    openchamberDataDir: dataDir,
    startSyncScheduler: false,
    ...overrides,
  });

  const server = app.listen(0);
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    calls,
    close: async () => {
      syncService.stop();
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await fs.rm(dataDir, { recursive: true, force: true });
    },
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
    appHandle = await startApp();
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
    appHandle = await startApp();
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
    appHandle = await startApp({
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
    appHandle = await startApp();
    const response = await fetch(`${appHandle.baseUrl}/api/config/agents-catalog/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'owner/repo', gitIdentityId: 'missing' }),
    });

    expect(response.status).toBe(400);
    expect(appHandle.calls).toEqual([]);
  });

  it('stores the repository override choice and synchronizes on request', async () => {
    appHandle = await startApp();
    const added = await fetch(`${appHandle.baseUrl}/api/config/agents-catalog/sync-sources`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Team agents',
        source: 'owner/repo',
        path: 'agents',
        ref: 'main',
        gitIdentityId: null,
        intervalSeconds: 300,
        autoSync: true,
        overrideCustomizedAgents: true,
      }),
    });
    const addBody = await added.json();

    expect(added.status).toBe(201);
    expect(addBody.source).toMatchObject({
      name: 'Team agents',
      overrideCustomizedAgents: true,
      status: 'pending',
    });
    expect(addBody.source.managedAgents).toBeUndefined();

    const synced = await fetch(`${appHandle.baseUrl}/api/config/agents-catalog/sync-sources/${addBody.source.id}/sync`, {
      method: 'POST',
    });
    expect(synced.status).toBe(200);
    expect(await synced.json()).toMatchObject({ ok: true, source: { status: 'synced' } });
  });

  it('accepts explicit synced-agent deletion when removing a source', async () => {
    appHandle = await startApp();
    const added = await fetch(`${appHandle.baseUrl}/api/config/agents-catalog/sync-sources`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Team agents',
        source: 'owner/repo',
        path: 'agents',
        ref: '',
        gitIdentityId: null,
        intervalSeconds: 3600,
        autoSync: false,
        overrideCustomizedAgents: false,
      }),
    });
    const { source } = await added.json();

    const removed = await fetch(`${appHandle.baseUrl}/api/config/agents-catalog/sync-sources/${source.id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deleteSyncedAgents: true }),
    });

    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ ok: true });
    expect(await fetch(`${appHandle.baseUrl}/api/config/agents-catalog/sync-sources`).then((response) => response.json()))
      .toMatchObject({ ok: true, sources: [] });
  });

  it('rejects invalid synced-agent deletion options', async () => {
    appHandle = await startApp();
    const removed = await fetch(`${appHandle.baseUrl}/api/config/agents-catalog/sync-sources/not-a-source`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deleteSyncedAgents: 'yes' }),
    });

    expect(removed.status).toBe(400);
    expect(await removed.json()).toMatchObject({ ok: false, error: { kind: 'invalidRequest' } });
  });
});
