import { createHash } from 'node:crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import yaml from 'yaml';
import { z } from 'zod';

import { assertGitAvailable, looksLikeAuthError, runGit } from '../skills-catalog/git.js';
import { parseSkillRepoSource } from '../skills-catalog/source.js';

const MAX_AGENT_FILES = 200;
const MAX_AGENT_BYTES = 1024 * 1024;
const AGENT_CONFIG_KEYS = new Set([
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
]);
const scanInputSchema = z.object({
  source: z.string().trim().min(1),
  subpath: z.string().optional(),
  ref: z.string().optional(),
  identity: z.object({ sshKey: z.string() }).nullable().optional(),
});
const agentMarkdownInputSchema = z.object({
  content: z.string(),
  filePath: z.string(),
});
const agentFrontmatterSchema = z.object({
  description: z.string().optional(),
  model: z.string().optional(),
  mode: z.enum(['primary', 'subagent', 'all']).optional(),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  steps: z.number().int().positive().optional(),
  hidden: z.boolean().optional(),
  color: z.string().optional(),
  permission: z.record(z.string(), z.enum(['allow', 'ask', 'deny'])).optional(),
  tools: z.record(z.string(), z.boolean()).optional(),
}).passthrough();
const agentNameSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
const refSchema = z.string().max(255)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/)
  .refine((value) => !value.includes('..')
    && !value.includes('//')
    && !value.includes('@{')
    && !value.endsWith('/')
    && !value.endsWith('.'));

function normalizeSubpath(value) {
  if (value === undefined || value.trim() === '') return '';
  const normalized = value.trim().replaceAll('\\', '/').replace(/^\/+|\/+$/g, '');
  const segments = normalized.split('/');
  if (normalized.length > 240 || segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    return null;
  }
  return normalized;
}

function parseAgentMarkdown(content, filePath) {
  const input = agentMarkdownInputSchema.parse({ content, filePath });
  const text = input.content.charCodeAt(0) === 0xfeff ? input.content.slice(1) : input.content;
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
  if (!match) {
    return { ok: false, reason: 'missingFrontmatter' };
  }

  let frontmatter;
  try {
    frontmatter = z.record(z.string(), z.unknown()).parse(yaml.parse(match[1]));
  } catch {
    return { ok: false, reason: 'invalidFrontmatter' };
  }

  const name = path.posix.basename(input.filePath, '.md');
  const parsedDescription = z.string().safeParse(frontmatter.description);
  const description = parsedDescription.success ? parsedDescription.data : '';
  const parsedConfig = agentFrontmatterSchema.safeParse(frontmatter);
  const config = parsedConfig.success
    ? Object.fromEntries(
      Object.entries(parsedConfig.data).filter(([key]) => AGENT_CONFIG_KEYS.has(key)),
    )
    : null;
  if (config) config.system = match[2].trim();
  return {
    ok: true,
    item: {
      name,
      path: input.filePath,
      description,
      installable: agentNameSchema.safeParse(name).success && config !== null,
    },
    config,
  };
}

function listAgentMarkdownPaths(treeOutput, subpath) {
  return treeOutput
    .split('\0')
    .filter(Boolean)
    .map((entry) => {
      const separator = entry.indexOf('\t');
      if (separator < 0) return null;
      const [mode, type] = entry.slice(0, separator).split(' ');
      const filePath = entry.slice(separator + 1);
      if (type !== 'blob' || (mode !== '100644' && mode !== '100755') || !filePath.endsWith('.md')) return null;
      if ((subpath && !filePath.startsWith(`${subpath}/`))
        || filePath.split('/').some((segment) => segment === '.' || segment === '..')) return null;
      return filePath;
    })
    .filter((filePath) => filePath !== null)
    .sort();
}

async function removeTempDir(tempDir) {
  await fs.promises.rm(tempDir, { recursive: true, force: true });
}

async function cloneRepo(cloneUrl, tempDir, identity, git, ref) {
  let cloned = await git(['clone', '--depth', '1', '--filter=blob:none', '--no-checkout', cloneUrl, tempDir], {
    identity,
    timeoutMs: 60_000,
  });
  if (!cloned.ok) {
    cloned = await git(['clone', '--depth', '1', '--no-checkout', cloneUrl, tempDir], {
      identity,
      timeoutMs: 60_000,
    });
  }
  if (!cloned.ok) return { ok: false, error: cloned };

  if (ref) {
    const fetched = await git(['-C', tempDir, 'fetch', '--depth=1', 'origin', ref], {
      identity,
      timeoutMs: 60_000,
    });
    if (!fetched.ok) return { ok: false, error: fetched };
    const checkedOut = await git(['-C', tempDir, 'checkout', '--detach', 'FETCH_HEAD'], {
      identity,
      timeoutMs: 30_000,
    });
    if (!checkedOut.ok) return { ok: false, error: checkedOut };
  }
  return { ok: true };
}

export async function scanAgentsRepository({ source, subpath, ref, identity, includeDefinitions = false, git = runGit } = {}) {
  const gitCheck = await assertGitAvailable();
  if (!gitCheck.ok) return { ok: false, error: gitCheck.error };

  const input = scanInputSchema.safeParse({ source, subpath, ref, identity });
  if (!input.success) {
    return { ok: false, error: { kind: 'invalidSource', message: 'Invalid repository scan parameters' } };
  }
  const parsed = parseSkillRepoSource(input.data.source);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const effectiveSubpath = normalizeSubpath(input.data.subpath);
  if (effectiveSubpath === null) {
    return { ok: false, error: { kind: 'invalidSource', message: 'Invalid repository path' } };
  }
  if (input.data.ref && !refSchema.safeParse(input.data.ref).success) {
    return { ok: false, error: { kind: 'invalidSource', message: 'Invalid repository ref' } };
  }

  const cloneUrl = input.data.identity?.sshKey ? parsed.cloneUrlSsh : parsed.cloneUrlHttps;
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'openchamber-agents-catalog-'));
  try {
    const cloned = await cloneRepo(cloneUrl, tempDir, input.data.identity, git, input.data.ref);
    if (!cloned.ok) {
      const message = `${cloned.error?.stderr || ''}\n${cloned.error?.message || ''}`.trim();
      const auth = looksLikeAuthError(message);
      return {
        ok: false,
        error: {
          kind: auth ? 'authRequired' : 'networkError',
          message: auth ? 'Authentication required to access this repository' : (message || 'Failed to clone repository'),
        },
      };
    }

    const treeArgs = ['-C', tempDir, 'ls-tree', '-r', '-z', 'HEAD'];
    if (effectiveSubpath) treeArgs.push('--', effectiveSubpath);
    const tree = await git(treeArgs, {
      identity: input.data.identity,
      timeoutMs: 30_000,
    });
    if (!tree.ok) {
      return { ok: false, error: { kind: 'networkError', message: tree.stderr || 'Failed to list repository files' } };
    }

    const entries = listAgentMarkdownPaths(tree.stdout, effectiveSubpath);

    if (entries.length > MAX_AGENT_FILES) {
      return { ok: false, error: { kind: 'tooManyFiles', message: `Repository path contains more than ${MAX_AGENT_FILES} Markdown files` } };
    }

    const items = [];
    const definitions = [];
    const failures = [];
    let index = 0;
    const readNext = async () => {
      while (index < entries.length) {
        const filePath = entries[index++];
        const blob = await git(['-C', tempDir, 'show', `HEAD:${filePath}`], {
          identity: input.data.identity,
          timeoutMs: 15_000,
          maxBuffer: MAX_AGENT_BYTES + 1,
        });
        if (!blob.ok) {
          failures.push(filePath);
          continue;
        }
        if (Buffer.byteLength(blob.stdout, 'utf8') > MAX_AGENT_BYTES) {
          failures.push(filePath);
          continue;
        }
        const parsedAgent = parseAgentMarkdown(blob.stdout, filePath);
        if (parsedAgent.ok) {
          items.push(parsedAgent.item);
          if (parsedAgent.item.installable && parsedAgent.config) {
            definitions.push({
              name: parsedAgent.item.name,
              path: parsedAgent.item.path,
              config: parsedAgent.config,
              remoteHash: createHash('sha256').update(blob.stdout).digest('hex'),
            });
          }
        } else {
          failures.push(filePath);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(6, entries.length || 1) }, () => readNext()));
    items.sort((left, right) => left.name.localeCompare(right.name));
    const nameCounts = new Map();
    for (const filePath of entries) {
      const name = path.posix.basename(filePath, '.md');
      nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
    }
    for (const item of items) {
      if (nameCounts.get(item.name) > 1) item.installable = false;
    }

    const response = {
      ok: true,
      normalizedRepo: parsed.normalizedRepo,
      subpath: effectiveSubpath,
      items,
      skippedFiles: failures.length,
    };
    if (includeDefinitions) {
      const commit = await git(['-C', tempDir, 'rev-parse', 'HEAD'], {
        identity: input.data.identity,
        timeoutMs: 15_000,
      });
      if (!commit.ok) {
        return { ok: false, error: { kind: 'networkError', message: commit.stderr || 'Failed to resolve repository commit' } };
      }
      const installablePaths = new Set(items.filter((item) => item.installable).map((item) => item.path));
      return {
        ...response,
        commit: commit.stdout.trim(),
        definitions: definitions.filter((definition) => installablePaths.has(definition.path)),
      };
    }

    return response;
  } finally {
    await removeTempDir(tempDir);
  }
}

export async function readAgentFromRepository({ source, subpath, ref, agentPath, identity, git = runGit } = {}) {
  const input = scanInputSchema.extend({
    agentPath: z.string().endsWith('.md'),
  }).safeParse({ source, subpath, ref, agentPath, identity });
  if (!input.success || input.data.agentPath.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
    return { ok: false, error: { kind: 'invalidSource', message: 'Invalid agent file path' } };
  }
  const gitCheck = await assertGitAvailable();
  if (!gitCheck.ok) return { ok: false, error: gitCheck.error };
  const effectiveSubpath = normalizeSubpath(input.data.subpath);
  if (effectiveSubpath === null || (effectiveSubpath && !input.data.agentPath.startsWith(`${effectiveSubpath}/`))) {
    return { ok: false, error: { kind: 'invalidSource', message: 'Invalid agent file path' } };
  }
  if (input.data.ref && !refSchema.safeParse(input.data.ref).success) {
    return { ok: false, error: { kind: 'invalidSource', message: 'Invalid repository ref' } };
  }
  const name = path.posix.basename(input.data.agentPath, '.md');
  if (!agentNameSchema.safeParse(name).success) {
    return { ok: false, error: { kind: 'invalidSource', message: 'Invalid agent name' } };
  }
  const parsed = parseSkillRepoSource(input.data.source);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const cloneUrl = input.data.identity?.sshKey ? parsed.cloneUrlSsh : parsed.cloneUrlHttps;
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'openchamber-agents-install-'));
  try {
    const cloned = await cloneRepo(cloneUrl, tempDir, input.data.identity, git, input.data.ref);
    if (!cloned.ok) {
      const message = `${cloned.error?.stderr || ''}\n${cloned.error?.message || ''}`.trim();
      return {
        ok: false,
        error: looksLikeAuthError(message)
          ? { kind: 'authRequired', message: 'Authentication required to access this repository' }
          : { kind: 'networkError', message: message || 'Failed to clone repository' },
      };
    }
    const listingArgs = ['-C', tempDir, 'ls-tree', '-r', '-z', 'HEAD'];
    if (effectiveSubpath) listingArgs.push('--', effectiveSubpath);
    const listing = await git(listingArgs, {
      identity: input.data.identity,
      timeoutMs: 15_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    if (!listing.ok) {
      return { ok: false, error: { kind: 'networkError', message: 'Failed to list agent files in repository' } };
    }
    const filePaths = listAgentMarkdownPaths(listing.stdout, effectiveSubpath);
    if (filePaths.length > MAX_AGENT_FILES) {
      return { ok: false, error: { kind: 'tooManyFiles', message: `Repository path contains more than ${MAX_AGENT_FILES} Markdown files` } };
    }
    if (!filePaths.includes(input.data.agentPath)) {
      return { ok: false, error: { kind: 'notFound', message: 'Agent is no longer available at this path' } };
    }
    const sameNamePaths = filePaths.filter((filePath) => path.posix.basename(filePath, '.md') === name);
    if (sameNamePaths.length !== 1) {
      return { ok: false, error: { kind: 'invalidAgent', message: 'Agent name is ambiguous in this repository path' } };
    }
    const blob = await git(['-C', tempDir, 'show', `HEAD:${input.data.agentPath}`], {
      identity: input.data.identity,
      timeoutMs: 15_000,
      maxBuffer: MAX_AGENT_BYTES + 1,
    });
    if (!blob.ok || Buffer.byteLength(blob.stdout, 'utf8') > MAX_AGENT_BYTES) {
      return { ok: false, error: { kind: 'networkError', message: 'Failed to read agent file or file exceeds size limit' } };
    }

    const match = blob.stdout.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
    if (!match) return { ok: false, error: { kind: 'invalidAgent', message: 'Agent frontmatter is missing' } };
    let rawConfig;
    try {
      rawConfig = yaml.parse(match[1]);
    } catch {
      return { ok: false, error: { kind: 'invalidAgent', message: 'Agent frontmatter is invalid' } };
    }
    const parsedConfig = agentFrontmatterSchema.safeParse(rawConfig);
    if (!parsedConfig.success) {
      return { ok: false, error: { kind: 'invalidAgent', message: 'Agent frontmatter must be a YAML mapping' } };
    }
    const parsedAgent = parseAgentMarkdown(blob.stdout, input.data.agentPath);
    if (!parsedAgent.ok || !parsedAgent.item.installable) {
      return { ok: false, error: { kind: 'invalidAgent', message: 'Agent file cannot be installed' } };
    }
    const config = Object.fromEntries(
      Object.entries(parsedConfig.data).filter(([key]) => AGENT_CONFIG_KEYS.has(key)),
    );
    config.system = match[2].trim();
    return { ok: true, name, config };
  } finally {
    await removeTempDir(tempDir);
  }
}
