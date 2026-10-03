import { z } from 'zod';
import { createAgentsCatalogSyncService, agentCatalogSourceInputSchema } from './sync.js';

const catalogRequestSchema = z.object({
  source: z.string(),
  path: z.string().optional(),
  ref: z.string().optional(),
  agentPath: z.string().optional(),
  gitIdentityId: z.string().optional(),
});

export async function registerAgentsCatalogRoutes(app, dependencies) {
  const {
    createAgent,
    deleteAgent,
    getAgentConfig,
    AGENT_SCOPE,
    getProfile,
    readAgentFromRepository,
    scanAgentsRepository,
    updateAgent,
    openchamberDataDir,
    startSyncScheduler = true,
  } = dependencies;

  const resolveIdentity = (gitIdentityId) => {
    if (!gitIdentityId) return { valid: true, identity: null };
    const profile = getProfile(gitIdentityId.trim());
    if (!profile) return { valid: false, identity: null };
    const sshKeyResult = z.string().safeParse(profile.sshKey);
    const sshKey = sshKeyResult.success ? sshKeyResult.data.trim() : '';
    return { valid: true, identity: sshKey ? { sshKey } : null };
  };

  const syncService = createAgentsCatalogSyncService({
    openchamberDataDir,
    resolveIdentity,
    readAgentsRepository: scanAgentsRepository,
    getAgentConfig,
    createAgent,
    deleteAgent,
    updateAgent,
    userScope: AGENT_SCOPE.USER,
  });
  await syncService.initialize();
  if (startSyncScheduler) syncService.start();

  const parseSourceInput = (body, res) => {
    const parsed = agentCatalogSourceInputSchema.safeParse(body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: { kind: 'invalidSource', message: 'Invalid agent sync source settings' } });
      return null;
    }
    if (parsed.data.gitIdentityId && !resolveIdentity(parsed.data.gitIdentityId).valid) {
      res.status(400).json({ ok: false, error: { kind: 'invalidIdentity', message: 'Unknown Git identity' } });
      return null;
    }
    return parsed.data;
  };

  app.post('/api/config/agents-catalog/scan', async (req, res) => {
    const request = catalogRequestSchema.safeParse(req.body);
    if (!request.success) {
      return res.status(400).json({ ok: false, error: { kind: 'invalidSource', message: 'Invalid repository scan parameters' } });
    }
    const { source, path: subpath, ref, gitIdentityId } = request.data;
    try {
      const resolvedIdentity = resolveIdentity(gitIdentityId);
      if (!resolvedIdentity.valid) {
        return res.status(400).json({ ok: false, error: { kind: 'invalidIdentity', message: 'Unknown Git identity' } });
      }
      const result = await scanAgentsRepository({
        source,
        subpath,
        ref,
        identity: resolvedIdentity.identity,
      });
      if (!result.ok) {
        const status = result.error.kind === 'invalidSource' ? 400
          : result.error.kind === 'authRequired' ? 401
            : result.error.kind === 'tooManyFiles' ? 413 : 502;
        return res.status(status).json(result);
      }
      return res.json(result);
    } catch (error) {
      console.error('Failed to scan agent catalog repository:', error);
      return res.status(500).json({ ok: false, error: { kind: 'scanFailed', message: 'Failed to scan repository' } });
    }
  });

  app.post('/api/config/agents-catalog/install', async (req, res) => {
    const request = catalogRequestSchema.extend({ agentPath: z.string() }).safeParse(req.body);
    if (!request.success) {
      return res.status(400).json({ ok: false, error: { kind: 'invalidSource', message: 'Invalid agent installation request' } });
    }
    const { source, path: subpath, ref, agentPath, gitIdentityId } = request.data;
    try {
      const resolvedIdentity = resolveIdentity(gitIdentityId);
      if (!resolvedIdentity.valid) {
        return res.status(400).json({ ok: false, error: { kind: 'invalidIdentity', message: 'Unknown Git identity' } });
      }
      const result = await readAgentFromRepository({
        source,
        subpath,
        ref,
        agentPath,
        identity: resolvedIdentity.identity,
      });
      if (!result.ok) {
        const status = result.error.kind === 'invalidSource' ? 400
          : result.error.kind === 'notFound' ? 404
            : result.error.kind === 'authRequired' ? 401 : 502;
        return res.status(status).json(result);
      }
      const created = createAgent(result.name, result.config, null, AGENT_SCOPE.USER);
      return res.json({ ok: true, name: result.name, path: created.path });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to install agent';
      if (/already exists/i.test(message)) {
        return res.status(409).json({ ok: false, error: { kind: 'conflict', message } });
      }
      console.error('Failed to install catalog agent:', error);
      return res.status(500).json({ ok: false, error: { kind: 'installFailed', message: 'Failed to install agent' } });
    }
  });

  app.get('/api/config/agents-catalog/sync-sources', async (_req, res) => {
    try {
      return res.json({ ok: true, sources: await syncService.listSources() });
    } catch (error) {
      console.error('Failed to load Agents Catalog sync sources:', error);
      return res.status(500).json({ ok: false, error: { kind: 'loadFailed', message: 'Failed to load sync sources' } });
    }
  });

  app.post('/api/config/agents-catalog/sync-sources', async (req, res) => {
    const input = parseSourceInput(req.body, res);
    if (!input) return;
    try {
      const source = await syncService.createSource(input);
      return res.status(201).json({ ok: true, source });
    } catch (error) {
      console.error('Failed to add Agents Catalog sync source:', error);
      return res.status(500).json({ ok: false, error: { kind: 'saveFailed', message: 'Failed to save sync source' } });
    }
  });

  app.put('/api/config/agents-catalog/sync-sources/:id', async (req, res) => {
    const input = parseSourceInput(req.body, res);
    if (!input) return;
    try {
      const source = await syncService.updateSource(req.params.id, input);
      if (!source) {
        return res.status(404).json({ ok: false, error: { kind: 'notFound', message: 'Sync source not found' } });
      }
      return res.json({ ok: true, source });
    } catch (error) {
      console.error('Failed to update Agents Catalog sync source:', error);
      return res.status(500).json({ ok: false, error: { kind: 'saveFailed', message: 'Failed to save sync source' } });
    }
  });

  app.delete('/api/config/agents-catalog/sync-sources/:id', async (req, res) => {
    const request = z.object({ deleteSyncedAgents: z.boolean().default(false) }).safeParse(req.body ?? {});
    if (!request.success) {
      return res.status(400).json({ ok: false, error: { kind: 'invalidRequest', message: 'Invalid source removal options' } });
    }
    try {
      const removed = await syncService.removeSource(req.params.id, request.data);
      if (!removed) {
        return res.status(404).json({ ok: false, error: { kind: 'notFound', message: 'Sync source not found' } });
      }
      return res.json({ ok: true });
    } catch (error) {
      console.error('Failed to remove Agents Catalog sync source:', error);
      return res.status(500).json({ ok: false, error: { kind: 'removeFailed', message: 'Failed to remove sync source' } });
    }
  });

  app.post('/api/config/agents-catalog/sync-sources/:id/sync', async (req, res) => {
    try {
      const result = await syncService.syncSource(req.params.id);
      if (!result.ok) {
        const status = result.error.kind === 'notFound' ? 404
          : result.error.kind === 'invalidIdentity' ? 400
            : result.error.kind === 'authRequired' ? 401 : 502;
        return res.status(status).json({
          ok: false,
          error: result.error,
          source: result.source,
        });
      }
      return res.json({ ok: true, source: result.source });
    } catch (error) {
      console.error('Failed to synchronize Agents Catalog source:', error);
      return res.status(500).json({ ok: false, error: { kind: 'syncFailed', message: 'Failed to synchronize source' } });
    }
  });

  return syncService;
}
