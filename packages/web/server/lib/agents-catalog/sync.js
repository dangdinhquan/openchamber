import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

export const AGENT_SYNC_INTERVALS = [300, 3600, 21600, 86400];

const intervalSchema = z.union([
  z.literal(300),
  z.literal(3600),
  z.literal(21600),
  z.literal(86400),
]);

export const agentCatalogSourceInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  source: z.string().trim().min(1).max(2048),
  path: z.string().trim().max(240).default(''),
  ref: z.string().trim().max(255).default(''),
  gitIdentityId: z.string().trim().nullable().default(null),
  intervalSeconds: intervalSchema.default(3600),
  autoSync: z.boolean().default(true),
  overrideCustomizedAgents: z.boolean().default(false),
});

const managedAgentSchema = z.object({
  name: z.string().min(1),
  baselineHash: z.string().regex(/^[a-f0-9]{64}$/),
  remoteHash: z.string().regex(/^[a-f0-9]{64}$/),
});

const syncSummarySchema = z.object({
  updated: z.number().int().nonnegative(),
  conflicts: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});

const sourceSchema = agentCatalogSourceInputSchema.extend({
  id: z.string().uuid(),
  status: z.enum(['pending', 'synced', 'error']),
  lastAttemptAt: z.string().datetime().nullable(),
  lastSyncedAt: z.string().datetime().nullable(),
  lastSyncedCommit: z.string().nullable(),
  lastError: z.string().nullable(),
  lastSummary: syncSummarySchema.nullable(),
  managedAgents: z.array(managedAgentSchema),
});

const storeSchema = z.object({
  version: z.literal(1),
  sources: z.array(sourceSchema),
}).strict();
const jsonValueSchema = z.lazy(() => z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(jsonValueSchema),
  z.record(z.string(), jsonValueSchema),
]));

const STORE_FILE = 'agents-catalog-sources.json';
const SYNC_CHECK_INTERVAL_MS = 60_000;
const REPLACEABLE_FIELDS = [
  'description',
  'model',
  'mode',
  'temperature',
  'top_p',
  'steps',
  'hidden',
  'color',
  'permission',
  'tools',
  'system',
];

const canonicalJson = (value) => {
  const parsed = jsonValueSchema.parse(value);
  if (Array.isArray(parsed)) {
    return `[${parsed.map(canonicalJson).join(',')}]`;
  }
  const record = z.record(z.string(), jsonValueSchema).safeParse(parsed);
  if (record.success) {
    const keys = Object.keys(record.data).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record.data[key])}`).join(',')}}`;
  }
  return JSON.stringify(parsed);
};

const hashConfig = (config) => createHash('sha256').update(canonicalJson(config)).digest('hex');

const toPublicSource = (source) => {
  const { managedAgents: _managedAgents, ...publicSource } = source;
  return publicSource;
};

const parseStore = (contents) => {
  let payload;
  try {
    payload = JSON.parse(contents);
  } catch (error) {
    throw new Error(`Invalid agents catalog sync state JSON: ${error.message}`);
  }
  return storeSchema.parse(payload);
};

export function createAgentsCatalogSyncService({
  openchamberDataDir,
  resolveIdentity,
  readAgentsRepository,
  getAgentConfig,
  createAgent,
  updateAgent,
  deleteAgent,
  userScope,
  now = () => new Date(),
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  logger = console,
}) {
  const dataDir = z.string().trim().min(1).parse(openchamberDataDir);

  const storePath = path.join(dataDir, STORE_FILE);
  let sources = null;
  let operations = Promise.resolve();
  let schedulerTimer = null;
  let schedulerBusy = false;

  const enqueue = (operation) => {
    const result = operations.then(operation);
    operations = result.then(() => undefined, () => undefined);
    return result;
  };

  const persist = async (nextSources) => {
    const payload = storeSchema.parse({ version: 1, sources: nextSources });
    await fs.mkdir(dataDir, { recursive: true });
    const temporaryPath = `${storePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await fs.rename(temporaryPath, storePath);
    } finally {
      await fs.rm(temporaryPath, { force: true });
    }
    sources = payload.sources;
  };

  const getSource = (sourceId) => sources.find((source) => source.id === sourceId) ?? null;

  const updatePersistedSource = async (sourceId, update) => {
    const current = getSource(sourceId);
    if (!current) return null;
    const nextSource = sourceSchema.parse(update(current));
    const nextSources = sources.map((source) => source.id === sourceId ? nextSource : source);
    await persist(nextSources);
    return nextSource;
  };

  const runSync = async (sourceId) => {
    const source = getSource(sourceId);
    if (!source) return { ok: false, error: { kind: 'notFound' }, source: null };

    const attemptedAt = now().toISOString();
    const identityResult = source.gitIdentityId
      ? resolveIdentity(source.gitIdentityId)
      : { valid: true, identity: null };
    if (!identityResult.valid) {
      const failedSource = await updatePersistedSource(sourceId, (current) => ({
        ...current,
        status: 'error',
        lastAttemptAt: attemptedAt,
        lastError: 'invalidIdentity',
        lastSummary: { updated: 0, conflicts: 0, skipped: 0, failed: 0 },
      }));
      return {
        ok: false,
        error: { kind: 'invalidIdentity', message: 'Unknown Git identity' },
        source: toPublicSource(failedSource),
      };
    }

    const result = await readAgentsRepository({
      source: source.source,
      subpath: source.path,
      ref: source.ref,
      identity: identityResult.identity,
      includeDefinitions: true,
    });
    if (!result.ok) {
      const failedSource = await updatePersistedSource(sourceId, (current) => ({
        ...current,
        status: 'error',
        lastAttemptAt: attemptedAt,
        lastError: result.error.kind,
        lastSummary: { updated: 0, conflicts: 0, skipped: 0, failed: 0 },
      }));
      return {
        ok: false,
        error: result.error,
        source: toPublicSource(failedSource),
      };
    }

    const currentSource = getSource(sourceId);
    const oldManaged = new Map(currentSource.managedAgents.map((agent) => [agent.name, agent]));
    const otherOwners = new Set(
      sources
        .filter((candidate) => candidate.id !== sourceId)
        .flatMap((candidate) => candidate.managedAgents.map((agent) => agent.name)),
    );
    const nextManaged = new Map(currentSource.managedAgents.map((agent) => [agent.name, agent]));
    const summary = {
      updated: 0,
      conflicts: 0,
      skipped: result.skippedFiles + result.items.filter((item) => !item.installable).length,
      failed: 0,
    };

    for (const definition of result.definitions) {
      if (otherOwners.has(definition.name)) {
        summary.conflicts += 1;
        continue;
      }

      const previous = oldManaged.get(definition.name);
      let current;
      try {
        current = getAgentConfig(definition.name, null);
        const localHash = current.source === 'none' ? null : hashConfig(current.config);
        const unchanged = previous !== undefined && localHash === previous.baselineHash;
        const remoteUnchanged = previous?.remoteHash === definition.remoteHash;
        if (previous && localHash !== previous.baselineHash && !currentSource.overrideCustomizedAgents) {
          summary.conflicts += 1;
          continue;
        }
        if (!previous && localHash !== null && !currentSource.overrideCustomizedAgents) {
          summary.conflicts += 1;
          continue;
        }
        if (previous && unchanged && remoteUnchanged) {
          continue;
        }

        if (current.source === 'none') {
          createAgent(definition.name, definition.config, null, userScope);
        } else {
          const replacement = Object.fromEntries(
            REPLACEABLE_FIELDS.map((field) => [field, definition.config[field] ?? null]),
          );
          updateAgent(definition.name, replacement, null);
        }
        const written = getAgentConfig(definition.name, null);
        if (written.source === 'none') {
          throw new Error(`Agent ${definition.name} was not present after the sync write`);
        }
        nextManaged.set(definition.name, {
          name: definition.name,
          baselineHash: hashConfig(written.config),
          remoteHash: definition.remoteHash,
        });
        summary.updated += 1;
      } catch (error) {
        summary.failed += 1;
        logger.error(`Failed to sync agent "${definition.name}" from ${currentSource.source}:`, error);
      }
    }

    const completedAt = now().toISOString();
    const hasFailures = summary.failed > 0 || summary.skipped > 0;
    const syncedSource = await updatePersistedSource(sourceId, (current) => ({
      ...current,
      status: hasFailures ? 'error' : 'synced',
      lastAttemptAt: attemptedAt,
      lastSyncedAt: hasFailures ? current.lastSyncedAt : completedAt,
      lastSyncedCommit: hasFailures ? current.lastSyncedCommit : result.commit,
      lastError: hasFailures ? (summary.failed > 0 ? 'partialFailure' : 'invalidAgents') : null,
      lastSummary: summary,
      managedAgents: [...nextManaged.values()],
    }));

    const response = {
      ok: !hasFailures,
      source: toPublicSource(syncedSource),
    };
    if (hasFailures) {
      response.error = { kind: syncedSource.lastError, message: 'Some agents could not be synchronized' };
    }
    return response;
  };

  const syncDueSources = () => {
    if (schedulerBusy || !sources) return;
    schedulerBusy = true;
    void enqueue(async () => {
      const timestamp = now().getTime();
      for (const source of [...sources]) {
        if (!source.autoSync) continue;
        const lastAttempt = source.lastAttemptAt ? Date.parse(source.lastAttemptAt) : 0;
        if (timestamp - lastAttempt < source.intervalSeconds * 1000) continue;
        const result = await runSync(source.id);
        if (!result.ok) {
          logger.error(`Scheduled Agents Catalog sync failed for "${source.name}": ${result.error.kind}`);
        }
      }
    }).catch((error) => {
      logger.error('Failed to run scheduled Agents Catalog sync:', error);
    }).finally(() => {
      schedulerBusy = false;
    });
  };

  return {
    async initialize() {
      if (sources) return;
      let contents;
      try {
        contents = await fs.readFile(storePath, 'utf8');
      } catch (error) {
        if (error.code === 'ENOENT') {
          sources = [];
          return;
        }
        throw error;
      }
      sources = parseStore(contents).sources;
    },

    start() {
      if (schedulerTimer) return;
      schedulerTimer = setIntervalFn(syncDueSources, SYNC_CHECK_INTERVAL_MS);
      schedulerTimer.unref?.();
      syncDueSources();
    },

    stop() {
      if (!schedulerTimer) return;
      clearIntervalFn(schedulerTimer);
      schedulerTimer = null;
    },

    listSources() {
      return enqueue(() => sources.map(toPublicSource));
    },

    createSource(input) {
      return enqueue(async () => {
        const parsed = agentCatalogSourceInputSchema.parse(input);
        const source = sourceSchema.parse({
          ...parsed,
          id: randomUUID(),
          status: 'pending',
          lastAttemptAt: null,
          lastSyncedAt: null,
          lastSyncedCommit: null,
          lastError: null,
          lastSummary: null,
          managedAgents: [],
        });
        await persist([...sources, source]);
        return toPublicSource(source);
      });
    },

    updateSource(sourceId, input) {
      return enqueue(async () => {
        if (!getSource(sourceId)) return null;
        const parsed = agentCatalogSourceInputSchema.parse(input);
        const source = await updatePersistedSource(sourceId, (current) => ({
          ...current,
          ...parsed,
        }));
        return toPublicSource(source);
      });
    },

    removeSource(sourceId, { deleteSyncedAgents = false } = {}) {
      return enqueue(async () => {
        const source = getSource(sourceId);
        if (!source) return false;
        if (deleteSyncedAgents) {
          const otherOwners = new Set(
            sources
              .filter((candidate) => candidate.id !== sourceId)
              .flatMap((candidate) => candidate.managedAgents.map((agent) => agent.name)),
          );
          const failures = [];
          for (const managedAgent of source.managedAgents) {
            if (otherOwners.has(managedAgent.name)) {
              failures.push(managedAgent.name);
              logger.error(`Cannot delete synced agent "${managedAgent.name}" while another source manages it`);
              continue;
            }
            try {
              if (getAgentConfig(managedAgent.name, null).source !== 'none') {
                deleteAgent(managedAgent.name, null, userScope);
              }
            } catch (error) {
              failures.push(managedAgent.name);
              logger.error(`Failed to delete synced agent "${managedAgent.name}" from ${source.source}:`, error);
            }
          }
          if (failures.length > 0) {
            throw new Error(`Failed to delete ${failures.length} synced agent(s)`);
          }
        }
        await persist(sources.filter((source) => source.id !== sourceId));
        return true;
      });
    },

    syncSource(sourceId) {
      return enqueue(() => runSync(sourceId));
    },
  };
}
