import { z } from 'zod';
import { runtimeFetch } from '@/lib/runtime-fetch';

const catalogItemSchema = z.object({
  name: z.string(),
  path: z.string(),
  description: z.string(),
  installable: z.boolean(),
});

const scanResponseSchema = z.object({
  ok: z.literal(true),
  normalizedRepo: z.string(),
  subpath: z.string(),
  items: z.array(catalogItemSchema),
  skippedFiles: z.number().int().nonnegative(),
});

const installResponseSchema = z.object({
  ok: z.literal(true),
  name: z.string(),
  path: z.string(),
});

const syncSummarySchema = z.object({
  updated: z.number().int().nonnegative(),
  conflicts: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});

const syncSourceSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  source: z.string(),
  path: z.string(),
  ref: z.string(),
  gitIdentityId: z.string().nullable(),
  intervalSeconds: z.union([z.literal(300), z.literal(3600), z.literal(21600), z.literal(86400)]),
  autoSync: z.boolean(),
  overrideCustomizedAgents: z.boolean(),
  status: z.enum(['pending', 'synced', 'error']),
  lastAttemptAt: z.string().datetime().nullable(),
  lastSyncedAt: z.string().datetime().nullable(),
  lastSyncedCommit: z.string().nullable(),
  lastError: z.string().nullable(),
  lastSummary: syncSummarySchema.nullable(),
});

const sourcesResponseSchema = z.object({
  ok: z.literal(true),
  sources: z.array(syncSourceSchema),
});

const sourceResponseSchema = z.object({
  ok: z.literal(true),
  source: syncSourceSchema,
});

const removedResponseSchema = z.object({
  ok: z.literal(true),
});

const errorResponseSchema = z.object({
  ok: z.literal(false),
  error: z.object({
    kind: z.string(),
    message: z.string(),
  }),
  source: syncSourceSchema.optional(),
});

export type AgentsCatalogItem = z.infer<typeof catalogItemSchema>;
export type AgentsCatalogSyncSource = z.infer<typeof syncSourceSchema>;
export type AgentsCatalogSyncInput = {
  name: string;
  source: string;
  path: string;
  ref: string;
  gitIdentityId: string | null;
  intervalSeconds: 300 | 3600 | 21600 | 86400;
  autoSync: boolean;
  overrideCustomizedAgents: boolean;
};

const parseResponse = async <TSchema extends z.ZodType>(
  response: Response,
  schema: TSchema,
): Promise<z.infer<TSchema>> => {
  const payload: unknown = await response.json();
  if (!response.ok) {
    const error = errorResponseSchema.safeParse(payload);
    throw new Error(error.success ? error.data.error.kind : `Request failed (${response.status})`);
  }
  return schema.parse(payload);
};

export const scanAgentsCatalogRepository = async (input: {
  source: string;
  path: string;
  ref: string;
  gitIdentityId: string | null;
}): Promise<z.infer<typeof scanResponseSchema>> => {
  const response = await runtimeFetch('/api/config/agents-catalog/scan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(input),
  });
  return parseResponse(response, scanResponseSchema);
};

export const installCatalogAgent = async (input: {
  source: string;
  path: string;
  ref: string;
  agentPath: string;
  gitIdentityId: string | null;
}): Promise<z.infer<typeof installResponseSchema>> => {
  const response = await runtimeFetch('/api/config/agents-catalog/install', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(input),
  });
  return parseResponse(response, installResponseSchema);
};

export const listAgentsCatalogSyncSources = async (): Promise<AgentsCatalogSyncSource[]> => {
  const response = await runtimeFetch('/api/config/agents-catalog/sync-sources', {
    headers: { Accept: 'application/json' },
  });
  return (await parseResponse(response, sourcesResponseSchema)).sources;
};

export const saveAgentsCatalogSyncSource = async (
  input: AgentsCatalogSyncInput,
  sourceId: string | null,
): Promise<AgentsCatalogSyncSource> => {
  const response = await runtimeFetch(
    sourceId
      ? `/api/config/agents-catalog/sync-sources/${encodeURIComponent(sourceId)}`
      : '/api/config/agents-catalog/sync-sources',
    {
      method: sourceId ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(input),
    },
  );
  return (await parseResponse(response, sourceResponseSchema)).source;
};

export const removeAgentsCatalogSyncSource = async (
  sourceId: string,
  deleteSyncedAgents: boolean,
): Promise<void> => {
  const response = await runtimeFetch(`/api/config/agents-catalog/sync-sources/${encodeURIComponent(sourceId)}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ deleteSyncedAgents }),
  });
  await parseResponse(response, removedResponseSchema);
};

export const syncAgentsCatalogSource = async (sourceId: string): Promise<AgentsCatalogSyncSource> => {
  const response = await runtimeFetch(`/api/config/agents-catalog/sync-sources/${encodeURIComponent(sourceId)}/sync`, {
    method: 'POST',
    headers: { Accept: 'application/json' },
  });
  return (await parseResponse(response, sourceResponseSchema)).source;
};
