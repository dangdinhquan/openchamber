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

const errorResponseSchema = z.object({
  ok: z.literal(false),
  error: z.object({
    kind: z.string(),
    message: z.string(),
  }),
});

export type AgentsCatalogItem = z.infer<typeof catalogItemSchema>;

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
