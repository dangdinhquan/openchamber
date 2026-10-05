import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import yaml from 'yaml';

import { assertGitAvailable, looksLikeAuthError, runGit } from './git.js';
import { parseSkillRepoSource } from './source.js';

const AGENT_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

export async function scanAgentsRepository({ source, subpath, identity, credentialResolver } = {}) {
  const available = await assertGitAvailable();
  if (!available.ok) return { ok: false, error: available.error };
  const parsed = parseSkillRepoSource(source, { subpath });
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const effectiveSubpath = parsed.effectiveSubpath || '';
  if (effectiveSubpath && (effectiveSubpath.startsWith('/') || effectiveSubpath.split('/').some((part) => part === '..' || part === '.'))) {
    return { ok: false, error: { kind: 'invalidSource', message: 'Invalid repository subpath' } };
  }
  const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-agents-scan-'));
  const cloneUrl = identity?.transport === 'ssh' || identity?.sshKey ? parsed.cloneUrlSsh : parsed.cloneUrlHttps;
  const gitOptions = { identity, credentialResolver, timeoutMs: 60_000 };
  try {
    let cloned = await runGit(['clone', '--depth', '1', '--filter=blob:none', '--no-checkout', cloneUrl, repoDir], gitOptions);
    if (!cloned.ok && !looksLikeAuthError(`${cloned.stderr || ''}\n${cloned.message || ''}`)) {
      cloned = await runGit(['clone', '--depth', '1', '--no-checkout', cloneUrl, repoDir], gitOptions);
    }
    if (!cloned.ok) {
      const message = cloned.stderr || cloned.message || 'Failed to clone repository';
      return { ok: false, error: { kind: looksLikeAuthError(message) ? 'authRequired' : 'networkError', message } };
    }

    const listed = await runGit(['-C', repoDir, 'ls-tree', '-r', '--name-only', 'HEAD', ...(effectiveSubpath ? ['--', effectiveSubpath] : [])], gitOptions);
    if (!listed.ok) return { ok: false, error: { kind: 'networkError', message: listed.stderr || listed.message } };

    const paths = listed.stdout.split(/\r?\n/).filter((entry) => {
      if (!entry.endsWith('.md') || entry.endsWith('/AGENTS.md') || entry === 'AGENTS.md'
        || entry.endsWith('/SKILL.md') || entry === 'SKILL.md') return false;
      if (effectiveSubpath) return entry.startsWith(`${effectiveSubpath}/`);
      return entry.startsWith('agents/') || entry.startsWith('agent/')
        || entry.startsWith('.opencode/agents/') || entry.startsWith('.opencode/agent/');
    }).slice(0, 500);
    const items = [];
    const seen = new Set();
    for (const agentPath of paths) {
      const name = path.posix.basename(agentPath, '.md');
      if (!AGENT_NAME.test(name) || name.length > 64 || seen.has(name)) continue;
      const blob = await runGit(['-C', repoDir, 'show', `HEAD:${agentPath}`], gitOptions);
      if (!blob.ok) continue;
      const match = blob.stdout.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
      if (!match) continue;
      let fields;
      try {
        fields = yaml.parse(match[1]);
      } catch {
        continue;
      }
      if (!fields || typeof fields !== 'object' || Array.isArray(fields) || typeof fields.description !== 'string') continue;
      seen.add(name);
      items.push({ name, description: fields.description, agentPath, source, subpath: effectiveSubpath || undefined,
        config: { ...fields, system: match[2].trim() } });
    }
    return { ok: true, items: items.sort((first, second) => first.name.localeCompare(second.name)) };
  } finally {
    await fs.rm(repoDir, { recursive: true, force: true });
  }
}