import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAgentsCatalogSyncService } from './sync.js';

const definition = (name, description, remoteHash = 'a'.repeat(64)) => ({
  name,
  path: `agents/${name}.md`,
  config: { description, system: `Prompt for ${name}` },
  remoteHash,
});

const sourceInput = (overrides = {}) => ({
  name: 'Team agents',
  source: 'owner/repo',
  path: 'agents',
  ref: '',
  gitIdentityId: null,
  intervalSeconds: 300,
  autoSync: true,
  overrideCustomizedAgents: false,
  ...overrides,
});

const makeService = async (overrides = {}) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-agent-sync-'));
  const agents = new Map();
  let definitions = [definition('reviewer', 'Remote reviewer')];
  let readResult = null;
  let readCount = 0;
  let intervalCallback = null;
  let timestamp = new Date('2026-10-01T00:00:00.000Z');
  const errors = [];
  const deletedAgents = [];
  const createService = () => createAgentsCatalogSyncService({
      openchamberDataDir: dataDir,
      resolveIdentity: () => ({ valid: true, identity: null }),
      readAgentsRepository: async () => {
        readCount += 1;
        return readResult ?? ({
          ok: true,
          commit: 'b'.repeat(40),
          skippedFiles: 0,
          items: definitions.map((entry) => ({ ...entry, installable: true })),
          definitions,
        });
      },
      getAgentConfig: (name) => {
        const config = agents.get(name);
        return config
          ? { source: 'md', config: structuredClone(config) }
          : { source: 'none', config: {} };
      },
      createAgent: (name, config) => {
        if (agents.has(name)) throw new Error(`Agent ${name} already exists`);
        agents.set(name, structuredClone(config));
      },
      updateAgent: (name, updates) => {
        const config = {};
        for (const [key, value] of Object.entries(updates)) {
          if (value !== null && value !== undefined) config[key] = value;
        }
        agents.set(name, config);
      },
      deleteAgent: (name, directory, scope) => {
        if (!agents.delete(name)) throw new Error(`Agent ${name} not found`);
        deletedAgents.push([name, directory, scope]);
      },
      userScope: 'user',
      now: () => timestamp,
      setIntervalFn: (callback) => {
        intervalCallback = callback;
        return { unref() {} };
      },
      clearIntervalFn: () => {
        intervalCallback = null;
      },
      logger: { error: (...values) => errors.push(values) },
      ...overrides,
    });
  let service = createService();
  await service.initialize();
  return {
    dataDir,
    agents,
    errors,
    deletedAgents,
    get service() { return service; },
    readCount: () => readCount,
    setDefinitions: (next) => { definitions = next; },
    setReadResult: (next) => { readResult = next; },
    setTimestamp: (next) => { timestamp = next; },
    tick: () => intervalCallback?.(),
    recreateService: async () => {
      service.stop();
      service = createService();
      await service.initialize();
    },
    cleanup: async () => {
      service.stop();
      await fs.rm(dataDir, { recursive: true, force: true });
    },
  };
};

describe('Agents Catalog sync service', () => {
  const instances = [];
  afterEach(async () => {
    await Promise.all(instances.splice(0).map((instance) => instance.cleanup()));
  });

  it('starts with an empty source list when persisted state is missing', async () => {
    const instance = await makeService();
    instances.push(instance);

    expect(await instance.service.listSources()).toEqual([]);
  });

  it('preserves sources and sync preferences after reloading persisted state', async () => {
    const instance = await makeService();
    instances.push(instance);
    const created = await instance.service.createSource(sourceInput({
      autoSync: false,
      intervalSeconds: 21600,
      overrideCustomizedAgents: true,
    }));

    await instance.recreateService();

    expect(await instance.service.listSources()).toEqual([expect.objectContaining({
      id: created.id,
      autoSync: false,
      intervalSeconds: 21600,
      overrideCustomizedAgents: true,
    })]);
  });

  it('defaults an omitted repository path to the repository root', async () => {
    const instance = await makeService();
    instances.push(instance);
    const created = await instance.service.createSource({
      name: 'Root agents',
      source: 'owner/repo',
    });

    await instance.recreateService();

    expect(await instance.service.listSources()).toEqual([
      expect.objectContaining({ id: created.id, path: '' }),
    ]);
  });

  it('serializes concurrent source updates in request order', async () => {
    const instance = await makeService();
    instances.push(instance);
    const source = await instance.service.createSource(sourceInput());

    await Promise.all([
      instance.service.updateSource(source.id, sourceInput({ name: 'Earlier update', autoSync: false })),
      instance.service.updateSource(source.id, sourceInput({ name: 'Later update', intervalSeconds: 21600 })),
    ]);

    expect((await instance.service.listSources())[0]).toMatchObject({
      name: 'Later update',
      autoSync: true,
      intervalSeconds: 21600,
    });
  });

  it('rejects malformed persisted state instead of treating it as empty', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-agent-sync-invalid-'));
    await fs.writeFile(path.join(dataDir, 'agents-catalog-sources.json'), '{broken', 'utf8');
    const service = createAgentsCatalogSyncService({
      openchamberDataDir: dataDir,
      resolveIdentity: () => ({ valid: true, identity: null }),
      readAgentsRepository: async () => ({ ok: true, definitions: [], items: [], skippedFiles: 0, commit: '' }),
      getAgentConfig: () => ({ source: 'none', config: {} }),
      createAgent: () => {},
      updateAgent: () => {},
      userScope: 'user',
    });

    await expect(service.initialize()).rejects.toThrow('Invalid agents catalog sync state JSON');
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it('installs a remote agent, then updates only after its remote definition changes', async () => {
    const instance = await makeService();
    instances.push(instance);
    const source = await instance.service.createSource(sourceInput());

    expect((await instance.service.syncSource(source.id)).source.lastSummary).toMatchObject({ updated: 1 });
    expect(instance.agents.get('reviewer').description).toBe('Remote reviewer');

    instance.setDefinitions([definition('reviewer', 'Updated reviewer', 'c'.repeat(64))]);
    const result = await instance.service.syncSource(source.id);

    expect(result.ok).toBe(true);
    expect(result.source.lastSummary.updated).toBe(1);
    expect(instance.agents.get('reviewer').description).toBe('Updated reviewer');
  });

  it('preserves customized agents until the source opts into overriding them', async () => {
    const instance = await makeService();
    instances.push(instance);
    const source = await instance.service.createSource(sourceInput());
    await instance.service.syncSource(source.id);

    instance.agents.set('reviewer', {
      description: 'My customized reviewer',
      system: 'My prompt',
    });
    instance.setDefinitions([definition('reviewer', 'New remote reviewer', 'c'.repeat(64))]);

    const preserved = await instance.service.syncSource(source.id);
    expect(preserved.source.lastSummary.conflicts).toBe(1);
    expect(instance.agents.get('reviewer').description).toBe('My customized reviewer');

    await instance.service.updateSource(source.id, sourceInput({ overrideCustomizedAgents: true }));
    const overridden = await instance.service.syncSource(source.id);
    expect(overridden.source.lastSummary.updated).toBe(1);
    expect(instance.agents.get('reviewer').description).toBe('New remote reviewer');
  });

  it('keeps source ownership through conflicts so a restored agent can sync again', async () => {
    const instance = await makeService();
    instances.push(instance);
    const source = await instance.service.createSource(sourceInput());
    await instance.service.syncSource(source.id);

    instance.agents.set('reviewer', {
      description: 'Local customization',
      system: 'Local prompt',
    });
    const conflict = await instance.service.syncSource(source.id);
    expect(conflict.source.lastSummary.conflicts).toBe(1);

    instance.agents.set('reviewer', {
      description: 'Remote reviewer',
      system: 'Prompt for reviewer',
    });
    instance.setDefinitions([definition('reviewer', 'Updated reviewer', 'c'.repeat(64))]);

    const restored = await instance.service.syncSource(source.id);

    expect(restored.source.lastSummary).toMatchObject({ updated: 1, conflicts: 0 });
    expect(instance.agents.get('reviewer').description).toBe('Updated reviewer');
  });

  it('does not treat a reordered equivalent agent config as a local customization', async () => {
    const instance = await makeService();
    instances.push(instance);
    const source = await instance.service.createSource(sourceInput());
    await instance.service.syncSource(source.id);
    instance.agents.set('reviewer', {
      system: 'Prompt for reviewer',
      description: 'Remote reviewer',
    });

    const result = await instance.service.syncSource(source.id);

    expect(result.source.lastSummary).toMatchObject({ updated: 0, conflicts: 0 });
  });

  it('counts non-installable definitions as skipped', async () => {
    const instance = await makeService();
    instances.push(instance);
    instance.setDefinitions([]);
    instance.setReadResult({
      ok: true,
      commit: 'b'.repeat(40),
      skippedFiles: 1,
      items: [{ name: 'invalid name', installable: false }],
      definitions: [],
    });
    const source = await instance.service.createSource(sourceInput());

    const result = await instance.service.syncSource(source.id);

    expect(result.source.lastSummary).toMatchObject({ skipped: 2 });
    expect(result.source.lastError).toBe('invalidAgents');
  });

  it('rejects an unknown Git identity without reading the repository', async () => {
    const instance = await makeService({
      resolveIdentity: () => ({ valid: false, identity: null }),
    });
    instances.push(instance);
    const source = await instance.service.createSource(sourceInput({ gitIdentityId: 'missing' }));

    const result = await instance.service.syncSource(source.id);

    expect(result.error.kind).toBe('invalidIdentity');
    expect(result.source.status).toBe('error');
    expect(instance.readCount()).toBe(0);
  });

  it('does not let two sources manage an agent with the same name', async () => {
    const instance = await makeService();
    instances.push(instance);
    const first = await instance.service.createSource(sourceInput({ name: 'First source' }));
    const second = await instance.service.createSource(sourceInput({ name: 'Second source' }));
    await instance.service.syncSource(first.id);
    instance.setDefinitions([definition('reviewer', 'Second source reviewer', 'c'.repeat(64))]);

    const result = await instance.service.syncSource(second.id);

    expect(result.source.lastSummary.conflicts).toBe(1);
    expect(instance.agents.get('reviewer').description).toBe('Remote reviewer');
  });

  it('continues syncing other agents when one agent write fails', async () => {
    const instance = await makeService({
      createAgent: (name, config) => {
        if (name === 'broken') throw new Error('Write failed');
        instance.agents.set(name, structuredClone(config));
      },
    });
    instances.push(instance);
    instance.setDefinitions([
      definition('broken', 'Broken'),
      definition('reviewer', 'Working'),
    ]);
    const source = await instance.service.createSource(sourceInput());

    const result = await instance.service.syncSource(source.id);

    expect(result.ok).toBe(false);
    expect(result.source.lastSummary).toMatchObject({ failed: 1, updated: 1 });
    expect(instance.agents.get('reviewer').description).toBe('Working');
    expect(instance.errors).toHaveLength(1);
  });

  it('runs due sources on startup and keeps installed agents when a source is removed', async () => {
    const instance = await makeService();
    instances.push(instance);
    const source = await instance.service.createSource(sourceInput());

    instance.service.start();
    expect((await instance.service.listSources())[0].status).toBe('synced');
    expect(instance.agents.has('reviewer')).toBe(true);

    expect(await instance.service.removeSource(source.id)).toBe(true);
    expect(await instance.service.listSources()).toEqual([]);
    expect(instance.agents.has('reviewer')).toBe(true);
  });

  it('deletes synced agents only when removal explicitly requests it', async () => {
    const preserved = await makeService();
    instances.push(preserved);
    const preservedSource = await preserved.service.createSource(sourceInput());
    await preserved.service.syncSource(preservedSource.id);

    expect(await preserved.service.removeSource(preservedSource.id)).toBe(true);
    expect(preserved.agents.has('reviewer')).toBe(true);

    const deleted = await makeService();
    instances.push(deleted);
    const source = await deleted.service.createSource(sourceInput());
    await deleted.service.syncSource(source.id);
    deleted.agents.set('reviewer', { description: 'My local edits', system: 'My prompt' });
    expect(await deleted.service.removeSource(source.id, { deleteSyncedAgents: true })).toBe(true);
    expect(deleted.agents.has('reviewer')).toBe(false);
    expect(deleted.deletedAgents).toEqual([['reviewer', null, 'user']]);
  });

  it('keeps the source when deleting a synced agent fails, so removal can be retried', async () => {
    const instance = await makeService({
      deleteAgent: () => {
        throw new Error('Delete failed');
      },
    });
    instances.push(instance);
    const source = await instance.service.createSource(sourceInput());
    await instance.service.syncSource(source.id);

    await expect(instance.service.removeSource(source.id, { deleteSyncedAgents: true }))
      .rejects.toThrow('Failed to delete 1 synced agent');
    expect((await instance.service.listSources()).map(({ id }) => id)).toEqual([source.id]);
    expect(instance.agents.has('reviewer')).toBe(true);
    expect(instance.errors).toHaveLength(1);
  });

  it('does not schedule paused sources and waits for the configured interval', async () => {
    const paused = await makeService();
    instances.push(paused);
    await paused.service.createSource(sourceInput({ autoSync: false }));
    paused.service.start();
    await paused.service.listSources();
    paused.setTimestamp(new Date('2026-10-01T01:00:00.000Z'));
    paused.tick();
    await paused.service.listSources();
    expect(paused.readCount()).toBe(0);

    const scheduled = await makeService();
    instances.push(scheduled);
    await scheduled.service.createSource(sourceInput({ intervalSeconds: 300 }));
    scheduled.service.start();
    await scheduled.service.listSources();
    expect(scheduled.readCount()).toBe(1);

    scheduled.setTimestamp(new Date('2026-10-01T00:04:59.999Z'));
    scheduled.tick();
    await scheduled.service.listSources();
    expect(scheduled.readCount()).toBe(1);

    scheduled.setTimestamp(new Date('2026-10-01T00:05:00.000Z'));
    scheduled.tick();
    await scheduled.service.listSources();
    expect(scheduled.readCount()).toBe(2);
  });

  it('does not replace persisted state when a repository fetch fails', async () => {
    const instance = await makeService();
    instances.push(instance);
    const source = await instance.service.createSource(sourceInput());
    instance.setReadResult({
      ok: false,
      error: { kind: 'networkError', message: 'Remote unavailable' },
    });

    const result = await instance.service.syncSource(source.id);

    expect(result.ok).toBe(false);
    expect(result.source.status).toBe('error');
    expect(result.source.lastSyncedAt).toBeNull();
    expect(instance.agents.size).toBe(0);
  });
});
