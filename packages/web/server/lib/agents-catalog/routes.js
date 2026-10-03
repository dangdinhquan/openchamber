import { z } from 'zod';

const catalogRequestSchema = z.object({
  source: z.string(),
  path: z.string().optional(),
  ref: z.string().optional(),
  agentPath: z.string().optional(),
  gitIdentityId: z.string().optional(),
});

export function registerAgentsCatalogRoutes(app, dependencies) {
  const {
    createAgent,
    AGENT_SCOPE,
    getProfile,
    readAgentFromRepository,
    scanAgentsRepository,
  } = dependencies;

  const resolveIdentity = (gitIdentityId) => {
    if (!gitIdentityId) return { valid: true, identity: null };
    const profile = getProfile(gitIdentityId.trim());
    if (!profile) return { valid: false, identity: null };
    const sshKeyResult = z.string().safeParse(profile.sshKey);
    const sshKey = sshKeyResult.success ? sshKeyResult.data.trim() : '';
    return { valid: true, identity: sshKey ? { sshKey } : null };
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
}
