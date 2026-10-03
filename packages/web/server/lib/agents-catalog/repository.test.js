import { describe, expect, it } from 'vitest';
import { readAgentFromRepository, scanAgentsRepository } from './repository.js';

const successful = (stdout = '') => ({ ok: true, stdout, stderr: '' });

describe('agents catalog repository scanning', () => {
  it('lists regular agent Markdown and rejects duplicate agent names', async () => {
    const calls = [];
    const git = async (args) => {
      calls.push(args);
      if (args[0] === 'clone') return successful();
      if (args.includes('ls-tree')) {
        return successful([
          '100644 blob a1\tagents/ops/reviewer.md',
          '100644 blob a2\tagents/team/reviewer.md',
          '100644 blob a4\tagents/bad.md',
          '120000 blob a3\tagents/link.md',
        ].join('\0') + '\0');
      }
      if (args.includes('show')) {
        return args.includes('HEAD:agents/bad.md')
          ? successful('---\nmode: invalid\n---\nBody')
          : successful('---\ndescription: Code review\n---\nReview the change.');
      }
      return successful();
    };

    const result = await scanAgentsRepository({
      source: 'owner/repo',
      subpath: 'agents',
      git,
    });

    expect(result).toMatchObject({
      ok: true,
      items: [
        { name: 'bad', installable: false },
        { name: 'reviewer', installable: false },
        { name: 'reviewer', installable: false },
      ],
      skippedFiles: 0,
    });
    expect(calls.filter((args) => args.includes('show'))).toHaveLength(3);
  });

  it('rejects traversal paths before cloning', async () => {
    let cloneCalled = false;
    const result = await scanAgentsRepository({
      source: 'owner/repo',
      subpath: '../outside',
      git: async (args) => {
        if (args[0] === 'clone') cloneCalled = true;
        return successful();
      },
    });

    expect(result).toMatchObject({ ok: false, error: { kind: 'invalidSource' } });
    expect(cloneCalled).toBe(false);
  });

  it('installs only regular Markdown beneath the selected path and filters frontmatter fields', async () => {
    const calls = [];
    const git = async (args) => {
      calls.push(args);
      if (args[0] === 'clone') return successful();
      if (args.includes('ls-tree')) return successful('100644 blob abc\tagents/reviewer.md\0');
      if (args.includes('show')) {
        return successful([
          '---',
          'description: Review code',
          'mode: subagent',
          'unexpected: ignored',
          '---',
          'Review the change.',
        ].join('\n'));
      }
      return successful();
    };

    const result = await readAgentFromRepository({
      source: 'owner/repo',
      subpath: 'agents',
      ref: 'main',
      agentPath: 'agents/reviewer.md',
      git,
    });

    expect(result).toEqual({
      ok: true,
      name: 'reviewer',
      config: { description: 'Review code', mode: 'subagent', system: 'Review the change.' },
    });
    expect(calls.some((args) => args.includes('fetch'))).toBe(true);
  });

  it('rejects ambiguous agent names during installation', async () => {
    const result = await readAgentFromRepository({
      source: 'owner/repo',
      subpath: 'agents',
      agentPath: 'agents/team/reviewer.md',
      git: async (args) => {
        if (args[0] === 'clone') return successful();
        if (args.includes('ls-tree')) {
          return successful([
            '100644 blob abc\tagents/team/reviewer.md',
            '100644 blob def\tagents/ops/reviewer.md',
          ].join('\0') + '\0');
        }
        return successful();
      },
    });

    expect(result).toMatchObject({ ok: false, error: { kind: 'invalidAgent' } });
  });

  it('rejects agent paths outside the selected subpath', async () => {
    const result = await readAgentFromRepository({
      source: 'owner/repo',
      subpath: 'agents',
      agentPath: 'other/reviewer.md',
      git: async () => successful(),
    });

    expect(result).toMatchObject({ ok: false, error: { kind: 'invalidSource' } });
  });
});
