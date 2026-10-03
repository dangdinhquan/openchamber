# Agents catalog

## Purpose

The Agents Catalog scans Git repositories for OpenCode agent Markdown and installs one selected definition into the user-global OpenCode config.

## Routes

- `POST /api/config/agents-catalog/scan` accepts `{ source, path, ref, gitIdentityId }` and returns normalized repository metadata plus installable agent summaries.
- `POST /api/config/agents-catalog/install` accepts the same source fields plus `agentPath`. It reads that file again from the repository before creating the agent.
- `DELETE /api/config/agents-catalog/sync-sources/:id` accepts `{ deleteSyncedAgents }`. The option defaults to `false`.
- These routes are OpenChamber-owned and registered separately from `/api/config/agents/:name`.

## Repository boundary

- Sources use the existing Git source parser. A blank path selects the repository root; nonblank paths reject dot and parent segments. Refs reject option-like strings and invalid Git-ref separators.
- Scans include only regular `.md` blobs below the configured path, or throughout the repository when the path is blank. Symlinks and other file types are never opened.
- A scan accepts at most 200 Markdown files and 1 MiB per file. Git runs non-interactively, and temporary clones are removed on success or failure.
- Agent names come from Markdown basenames and must match the OpenCode-compatible 64-character limit. Duplicate basenames and invalid metadata are shown as non-installable.
- Install parses YAML frontmatter, validates the supported OpenCode fields, and copies only those fields. It does not execute repository content, overwrite an existing user or project agent, or import supporting files.

## Runtime behavior

Web, Electron, hosted mobile, and Capacitor mobile call the shared OpenChamber server routes through `runtimeFetch`. The VS Code webview returns a stable `501` response because its extension host does not own Git clone or user-global agent installation.

## Scheduled sources

- The sync-source routes store source settings and managed-agent baselines in `agents-catalog-sources.json` under the OpenChamber data directory. Writes use a temporary file and atomic rename. Malformed state fails initialization instead of being treated as an empty source list.
- Sources can sync every 5 minutes, 1 hour, 6 hours, or 24 hours. The server checks for due sources once a minute and also supports an explicit sync request. Paused sources are not scheduled.
- Each sync reads the configured repository path and ref, then creates or updates validated user-scoped agent definitions. A failed repository read leaves installed agents and the last successful commit unchanged. A per-agent write failure does not stop other definitions from syncing.
- Customized agents are preserved by default. When override is enabled, the source may replace an agent with the same name. If another source manages that name, the sync reports a conflict instead of taking ownership.
- Local edits to an agent managed by a source are reported as conflicts while override is disabled. Removing a source does not remove installed agents. Removing a definition from a repository also does not delete its installed agent.
- Removing a source accepts `deleteSyncedAgents`, which defaults to `false`. When enabled, the server deletes every agent still tracked as managed by that source, including locally customized versions. If any deletion fails, the source record stays so the user can retry; agents already deleted remain absent, and a retry skips those missing agents.
- The stored baseline is compared with the current normalized agent config, so harmless key ordering changes do not count as local customization.
