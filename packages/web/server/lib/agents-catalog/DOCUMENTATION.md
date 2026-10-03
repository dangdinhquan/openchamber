# Agents catalog

## Purpose

The Agents Catalog scans Git repositories for OpenCode agent Markdown and installs one selected definition into the user-global OpenCode config.

## Routes

- `POST /api/config/agents-catalog/scan` accepts `{ source, path, ref, gitIdentityId }` and returns normalized repository metadata plus installable agent summaries.
- `POST /api/config/agents-catalog/install` accepts the same source fields plus `agentPath`. It reads that file again from the repository before creating the agent.
- Both routes are OpenChamber-owned and registered separately from `/api/config/agents/:name`.

## Repository boundary

- Sources use the existing Git source parser. Paths reject empty, dot, and parent segments. Refs reject option-like strings and invalid Git-ref separators.
- Scans include only regular `.md` blobs below the configured path. Symlinks and other file types are never opened.
- A scan accepts at most 200 Markdown files and 1 MiB per file. Git runs non-interactively, and temporary clones are removed on success or failure.
- Agent names come from Markdown basenames and must match the OpenCode-compatible 64-character limit. Duplicate basenames and invalid metadata are shown as non-installable.
- Install parses YAML frontmatter, validates the supported OpenCode fields, and copies only those fields. It does not execute repository content, overwrite an existing user or project agent, or import supporting files.

## Runtime behavior

Web, Electron, hosted mobile, and Capacitor mobile call the shared OpenChamber server routes through `runtimeFetch`. The VS Code webview returns a stable `501` response because its extension host does not own Git clone or user-global agent installation.
