import React from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Icon } from '@/components/icon/Icon';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { SettingsSection } from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { loadDesktopSettings, updateDesktopSettings } from '@/lib/persistence';
import type { SkillCatalogConfig } from '@/lib/desktop';
import { useSettingsDirectory } from '@/hooks/useSettingsDirectory';
import { isAgentBuiltIn, selectAgentsForDirectory, useAgentsStore } from '@/stores/useAgentsStore';
import { useGitIdentitiesStore } from '@/stores/useGitIdentitiesStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { CatalogSourceCard } from '@/components/sections/skills/catalog/SkillsCatalogPage';
import { rankByQuery } from '@/lib/search/fuzzySearch';
import { cn } from '@/lib/utils';
import { z } from 'zod';

const catalogItemSchema = z.object({ name: z.string(), description: z.string(), agentPath: z.string(), source: z.string(), subpath: z.string().optional(), sourceId: z.string().optional() });
const catalogResponseSchema = z.object({ ok: z.boolean(), sources: z.array(z.object({ id: z.string(), label: z.string(), source: z.string(), subpath: z.string().optional(), gitIdentityId: z.string().optional(), stars: z.number().nullable().optional(), repoUpdatedAt: z.string().nullable().optional() })).optional(), items: z.array(catalogItemSchema).optional(), error: z.object({ message: z.string() }).optional() });
type AgentItem = z.infer<typeof catalogItemSchema>;

const readCatalogResponse = async (response: Response, fallback: string) => {
  const parsed = catalogResponseSchema.safeParse(await response.json());
  if (!parsed.success || !response.ok || !parsed.data.ok) {
    throw new Error(parsed.success ? parsed.data.error?.message || fallback : fallback);
  }
  return parsed.data;
};

export const AgentsCatalogPage: React.FC = () => {
  const { t } = useI18n();
  const directory = useSettingsDirectory();
  const loadAgents = useAgentsStore((state) => state.loadAgents);
  const deleteAgent = useAgentsStore((state) => state.deleteAgent);
  const installedAgents = useAgentsStore((state) => selectAgentsForDirectory(state, directory));
  const projects = useProjectsStore((state) => state.projects);
  const activeProjectId = useProjectsStore((state) => state.activeProjectId);
  const identities = useGitIdentitiesStore((state) => state.profiles);
  const loadIdentities = useGitIdentitiesStore((state) => state.loadProfiles);
  const [sources, setSources] = React.useState<SkillCatalogConfig[]>([]);
  const [selected, setSelected] = React.useState<string | null>(null);
  const [itemsBySource, setItemsBySource] = React.useState<Record<string, AgentItem[]>>({});
  const [loadingSource, setLoadingSource] = React.useState<string | null>(null);
  const [loadedSourceIds, setLoadedSourceIds] = React.useState<Set<string>>(new Set());
  const [failedSourceIds, setFailedSourceIds] = React.useState<Set<string>>(new Set());
  const sourceRequests = React.useRef(new Set<string>());
  const sourceRef = React.useRef(new Map<string, string>());
  const [query, setQuery] = React.useState('');
  const searchRef = React.useRef<HTMLInputElement>(null);
  const [selectedKeys, setSelectedKeys] = React.useState<Set<string>>(new Set());
  const [installItems, setInstallItems] = React.useState<AgentItem[]>([]);
  const [scope, setScope] = React.useState<'user' | 'project'>('user');
  const [targetProjectId, setTargetProjectId] = React.useState<string | null>(null);
  const [uninstallItems, setUninstallItems] = React.useState<AgentItem[]>([]);
  const [isRemoving, setIsRemoving] = React.useState(false);
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [removeOpen, setRemoveOpen] = React.useState(false);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [label, setLabel] = React.useState('');
  const [source, setSource] = React.useState('');
  const [subpath, setSubpath] = React.useState('');
  const [gitIdentityId, setGitIdentityId] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [scanError, setScanError] = React.useState<string | null>(null);
  const [installing, setInstalling] = React.useState<string | null>(null);
  const [installedNames, setInstalledNames] = React.useState<Set<string>>(new Set());
  const [scanCount, setScanCount] = React.useState<number | null>(null);
  const [scanOk, setScanOk] = React.useState(false);
  const [scanVersion, setScanVersion] = React.useState(0);
  const scanVersionRef = React.useRef(0);
  const scanRequestRef = React.useRef(0);
  const lastScanRef = React.useRef<string | null>(null);
  const [existingCatalogs, setExistingCatalogs] = React.useState<SkillCatalogConfig[] | null>(null);
  const [hasLoadedCatalog, setHasLoadedCatalog] = React.useState(false);
  const invalidateDialogScan = () => { scanRequestRef.current += 1; lastScanRef.current = null; setScanOk(false); setScanCount(null); };

  React.useEffect(() => {
    if (!dialogOpen) return;
    let active = true;
    setExistingCatalogs(null);
    void loadDesktopSettings().then((settings) => { if (active) setExistingCatalogs(settings ? settings.agentCatalogs || [] : null); });
    return () => { active = false; scanRequestRef.current += 1; };
  }, [dialogOpen]);

  React.useEffect(() => {
    if (!installItems.length) return;
    setScope('user');
    setTargetProjectId(activeProjectId);
  }, [installItems.length, activeProjectId]);

  const refresh = React.useCallback(async () => {
    const response = await runtimeFetch('/api/config/agents/catalog');
    const result = await readCatalogResponse(response, t('settings.skills.catalog.page.error.catalogTitle'));
    const validIds = new Set((result.sources || []).map((catalog) => catalog.id));
    setItemsBySource((current) => Object.fromEntries(Object.entries(current).filter(([id]) => validIds.has(id))));
    for (const catalog of result.sources || []) {
      const signature = `${catalog.source}\0${catalog.subpath || ''}\0${catalog.gitIdentityId || ''}`;
      if (sourceRef.current.get(catalog.id) !== signature) {
        setLoadedSourceIds((current) => { const updated = new Set(current); updated.delete(catalog.id); return updated; });
        setFailedSourceIds((current) => { const updated = new Set(current); updated.delete(catalog.id); return updated; });
        sourceRef.current.set(catalog.id, signature);
      }
    }
    setSources(result.sources || []);
    setHasLoadedCatalog(true);
    setSelected((current) => result.sources?.some((entry) => entry.id === current) ? current : result.sources?.[0]?.id || null);
  }, [t]);

  React.useEffect(() => {
    void refresh().catch((error) => setScanError(error instanceof Error ? error.message : t('settings.skills.catalog.page.error.catalogTitle')));
  }, [refresh, t]);

  React.useEffect(() => { void loadIdentities(); }, [loadIdentities]);

  const scan = React.useCallback(async (catalog: Pick<SkillCatalogConfig, 'source' | 'subpath' | 'gitIdentityId'>) => {
    const response = await runtimeFetch('/api/config/agents/catalog/scan', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(catalog),
    });
    const result = await readCatalogResponse(response, t('settings.skills.catalog.page.error.catalogTitle'));
    return result.items || [];
  }, [t]);

  React.useEffect(() => {
    const next = sources.find((catalog) => !loadedSourceIds.has(catalog.id) && !failedSourceIds.has(catalog.id) && !sourceRequests.current.has(catalog.id));
    if (!next || loadingSource) return;
    sourceRequests.current.add(next.id);
    setLoadingSource(next.id);
    const version = scanVersionRef.current;
    const signature = `${next.source}\0${next.subpath || ''}\0${next.gitIdentityId || ''}`;
    void scan(next).then((items) => {
      if (version !== scanVersionRef.current || sourceRef.current.get(next.id) !== signature) return;
          setItemsBySource((current) => ({ ...current, [next.id]: items.map((item) => ({ ...item, sourceId: next.id })) }));
      setLoadedSourceIds((current) => new Set(current).add(next.id));
      setScanError(null);
    }).catch((error) => {
      if (version !== scanVersionRef.current || sourceRef.current.get(next.id) !== signature) return;
      setFailedSourceIds((current) => new Set(current).add(next.id));
      setScanError(error instanceof Error ? error.message : t('settings.skills.catalog.page.error.catalogTitle'));
    }).finally(() => {
      sourceRequests.current.delete(next.id);
      if (version === scanVersionRef.current) setLoadingSource(null);
      else setScanVersion(scanVersionRef.current);
    });
  }, [sources, loadedSourceIds, failedSourceIds, loadingSource, scan, t, scanVersion]);

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  React.useEffect(() => { void loadAgents(directory); }, [directory, loadAgents]);

  React.useEffect(() => { setInstalledNames(new Set()); setSelectedKeys(new Set()); }, [directory]);

  React.useEffect(() => {
    const available = new Set(sources.flatMap((catalog) => (itemsBySource[catalog.id] || []).map((item) => `${catalog.id}:${item.agentPath}`)));
    setSelectedKeys((current) => {
      const valid = [...current].filter((key) => available.has(key));
      return valid.length === current.size ? current : new Set(valid);
    });
  }, [itemsBySource, sources]);

  const save = async () => {
    if (!source.trim() || !label.trim()) return;
    setBusy(true);
    try {
      const currentEntry = sources.find((catalog) => catalog.id === editingId);
      const changed = !currentEntry || currentEntry.source !== source.trim() || (currentEntry.subpath || '') !== subpath.trim() || (currentEntry.gitIdentityId || null) !== gitIdentityId;
      if (changed && (!scanOk || lastScanRef.current !== JSON.stringify([source.trim(), subpath.trim(), gitIdentityId]))) throw new Error(t('settings.skills.catalog.add.toast.scanBeforeAdd'));
      const settings = await loadDesktopSettings();
      if (!settings || !existingCatalogs) throw new Error(t('settings.skills.catalog.add.toast.saveFailed'));
      const current = settings.agentCatalogs || [];
      const original = current.find((catalog) => catalog.id === editingId);
      if (editingId && !original) throw new Error(t('settings.skills.catalog.add.toast.saveFailed'));
      const next = { id: editingId || `custom:${Date.now()}`, label: label.trim(), source: source.trim(), subpath: subpath.trim() || undefined, gitIdentityId: gitIdentityId || undefined };
      if (current.some((catalog) => catalog.id !== editingId && catalog.source === next.source && (catalog.subpath || '') === (next.subpath || ''))) {
        throw new Error(t('settings.skills.catalog.add.toast.catalogAlreadyExists'));
      }
      const saved = await updateDesktopSettings({ agentCatalogs: editingId
        ? current.map((catalog) => catalog.id === editingId ? next : catalog)
        : [...current, next] });
      if (!saved.ok) throw new Error(t('settings.skills.catalog.add.toast.saveFailed'));
      scanVersionRef.current += 1;
      scanRequestRef.current += 1;
      setScanVersion(scanVersionRef.current);
      setLoadingSource(null);
      setLoadedSourceIds((current) => { const nextIds = new Set(current); nextIds.delete(next.id); return nextIds; });
      setFailedSourceIds((current) => { const nextIds = new Set(current); nextIds.delete(next.id); return nextIds; });
      await refresh();
      setSelected(next.id);
      setDialogOpen(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('settings.skills.catalog.add.toast.saveFailed'));
    } finally { setBusy(false); }
  };

  const remove = async () => {
    if (!selected) return;
    setIsRemoving(true);
    try {
      const settings = await loadDesktopSettings();
      if (!settings) throw new Error(t('settings.skills.catalog.add.toast.saveFailed'));
      const saved = await updateDesktopSettings({ agentCatalogs: (settings.agentCatalogs || []).filter((entry) => entry.id !== selected) });
      if (!saved.ok) throw new Error(t('settings.skills.catalog.add.toast.saveFailed'));
      setItemsBySource((current) => { const nextItems = { ...current }; delete nextItems[selected]; return nextItems; });
      setLoadedSourceIds((current) => { const nextIds = new Set(current); nextIds.delete(selected); return nextIds; });
      setSelected(null);
      setRemoveOpen(false);
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('settings.skills.catalog.add.toast.saveFailed'));
    } finally { setIsRemoving(false); }
  };

  const install = async (scope: 'user' | 'project', targetDirectory: string | null) => {
    setInstalling(installItems[0]?.agentPath || '');
    try {
      for (const item of installItems) {
        const catalog = sources.find((entry) => entry.id === item.sourceId);
        if (!catalog) throw new Error(t('settings.skills.catalog.installSkill.toast.installFailed'));
        const response = await runtimeFetch(`/api/config/agents/catalog/install?directory=${encodeURIComponent(targetDirectory || directory || '')}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sourceId: catalog?.id, agentPath: item.agentPath, scope }),
        });
        await readCatalogResponse(response, t('settings.skills.catalog.installSkill.toast.installFailed'));
        if (scope === 'user' || !targetDirectory || targetDirectory === directory) setInstalledNames((current) => new Set(current).add(item.name));
      }
      await loadAgents(targetDirectory || directory);
      setInstallItems([]);
      setSelectedKeys(new Set());
      toast.success(t('settings.agents.catalog.installed'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('settings.skills.catalog.installSkill.toast.installFailed'));
    } finally { setInstalling(null); }
  };

  const active = sources.find((entry) => entry.id === selected);
  const searching = Boolean(query.trim());
  const filtered = searching
    ? rankByQuery(sources.flatMap((entry) => itemsBySource[entry.id] || []), query, (item) => [item.name, item.description])
    : (selected ? itemsBySource[selected] || [] : []);
  const itemKey = (item: AgentItem) => `${item.sourceId}:${item.agentPath}`;
  const isInstalled = (item: AgentItem) => installedNames.has(item.name) || installedAgents.some((agent) => agent.name === item.name);
  const isRemovable = (item: AgentItem) => installedAgents.some((agent) => agent.name === item.name && !isAgentBuiltIn(agent));
  const selectedItems = filtered.filter((item) => selectedKeys.has(itemKey(item)));
  const selectedInstallItems = selectedItems.filter((item) => !isInstalled(item));
  const selectedUninstallItems = selectedItems.filter(isRemovable);
  const batchSource = selectedItems[0]?.sourceId ?? (searching ? filtered[0]?.sourceId : active?.id);
  const selectableItems = filtered.filter((item) => item.sourceId === batchSource && (!isInstalled(item) || isRemovable(item)));
  const allSelected = selectableItems.length > 0 && selectableItems.every((item) => selectedKeys.has(itemKey(item)));
  const resolvedProjectId = projects.some((project) => project.id === targetProjectId) ? targetProjectId : activeProjectId || projects[0]?.id;
  const targetProject = projects.find((project) => project.id === resolvedProjectId);
  const githubUrl = (item: AgentItem) => /^[\w.-]+\/[\w.-]+$/.test(item.source)
    ? `https://github.com/${item.source}/blob/HEAD/${item.agentPath}` : null;

  const uninstall = async () => {
    if (!uninstallItems.length) return;
    setIsRemoving(true);
    try {
      const remaining: AgentItem[] = [];
      for (const item of uninstallItems) {
        const installed = installedAgents.find((agent) => agent.name === item.name);
        if (!installed || isAgentBuiltIn(installed)) { remaining.push(item); continue; }
        try {
          const result = await deleteAgent(item.name, undefined, directory);
          if (!result.ok) { remaining.push(item); continue; }
          setInstalledNames((current) => { const next = new Set(current); next.delete(item.name); return next; });
          setSelectedKeys((current) => { const next = new Set(current); next.delete(itemKey(item)); return next; });
        } catch { remaining.push(item); }
      }
      setUninstallItems(remaining);
      if (remaining.length) toast.error(t('settings.agents.sidebar.toast.deleteFailed'));
      else if (uninstallItems.length === 1) toast.success(t('settings.agents.sidebar.toast.agentDeleted', { name: uninstallItems[0].name }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('settings.agents.sidebar.toast.deleteFailed'));
    } finally { setIsRemoving(false); }
  };

  const scanDialogSource = async () => {
    const request = ++scanRequestRef.current;
    const scannedFields = JSON.stringify([source.trim(), subpath.trim(), gitIdentityId]);
    setBusy(true);
    setScanOk(false);
    setScanCount(null);
    try {
      const results = await scan({ source: source.trim(), subpath: subpath.trim() || undefined, gitIdentityId: gitIdentityId || undefined });
      if (request !== scanRequestRef.current) return;
      setScanCount(results.length);
      if (results.length === 0) {
        toast.error(t('settings.agents.catalog.empty'));
        return;
      }
      setScanOk(true);
      lastScanRef.current = scannedFields;
      if (!label.trim()) setLabel(source.trim().replace(/^https:\/\//, '').replace(/\.git$/, ''));
      toast.success(t('settings.agents.catalog.count', { count: results.length }));
    } catch (error) {
      if (request === scanRequestRef.current) toast.error(error instanceof Error ? error.message : t('settings.skills.catalog.add.toast.scanFailed'));
    } finally {
      if (request === scanRequestRef.current) setBusy(false);
    }
  };

  return <>
    <SettingsPageLayout title={t('settings.page.agentsCatalog.title')} showSaveStatus={false}>
      <p className="typography-meta text-muted-foreground mb-4">{t('settings.agents.catalog.subtitle')}</p>
      <div data-settings-item="agents.catalog.search" className="mb-5">
        <div className="relative max-w-md">
          <Icon name="search" className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('settings.agents.catalog.search')} className={cn('h-8 pl-8 w-full', query && 'pr-8')} />
          {query && <button type="button" onClick={() => { setQuery(''); searchRef.current?.focus(); }} className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center justify-center h-4 w-4 rounded text-muted-foreground hover:text-foreground transition-colors" title={t('settings.skills.catalog.page.search.clear')}><Icon name="close" className="h-3 w-3" /></button>}
        </div>
      </div>
      <SettingsSection title={t('settings.skills.catalog.page.section.sources')} divider={false} settingsItem="agents.catalog.source" contentClassName="space-y-0">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 py-1.5">
          {sources.map((catalog) => <CatalogSourceCard key={catalog.id} source={{ ...catalog, sourceType: 'github' }} isActive={selected === catalog.id} isLoading={loadingSource === catalog.id} skillsCount={loadedSourceIds.has(catalog.id) ? (itemsBySource[catalog.id] || []).length : null} countLabel={loadedSourceIds.has(catalog.id) ? t('settings.agents.catalog.count', { count: (itemsBySource[catalog.id] || []).length }) : null} onSelect={() => setSelected(catalog.id)} t={t} />)}
          <button type="button" data-settings-item="agents.catalog.add-catalog" onClick={() => { setEditingId(null); setLabel(''); setSource(''); setSubpath(''); setGitIdentityId(null); invalidateDialogScan(); setDialogOpen(true); }} className="min-h-24 text-left rounded-lg border border-dashed border-[var(--interactive-border)] hover:border-[var(--interactive-border-hover)] hover:bg-[var(--surface-muted)] p-3.5 flex gap-3 items-start transition-colors">
            <span className="flex items-center justify-center rounded-md bg-transparent text-muted-foreground w-8 h-8 shrink-0"><Icon name="add" className="h-4 w-4" /></span>
            <span className="min-w-0"><span className="typography-ui-label text-muted-foreground block">{t('settings.skills.catalog.page.source.addOwnTitle')}</span><span className="typography-micro text-muted-foreground/70 block mt-0.5">{t('settings.agents.catalog.sourceDescription')}</span></span>
          </button>
        </div>
      </SettingsSection>
      {scanError && <SettingsSection><div className="rounded-lg border border-[var(--status-error-border)] bg-[var(--status-error-background)] px-4 py-3"><div className="typography-ui-label font-medium text-[var(--status-error)]">{t('settings.skills.catalog.page.error.catalogTitle')}</div><div className="typography-meta text-[var(--status-error)]/80 mt-1">{scanError}</div></div></SettingsSection>}
      <SettingsSection>
        <div className="flex items-center justify-between gap-2 pb-2">
          <div className="flex items-center gap-2 min-w-0"><span className="typography-micro font-medium uppercase tracking-wide text-muted-foreground truncate">{searching ? t('settings.skills.catalog.page.list.searchTitle') : active?.label || ''}</span><span className="typography-micro text-muted-foreground/70 shrink-0">{t('settings.agents.catalog.count', { count: filtered.length })}</span></div>
          <div className="flex items-center gap-1 shrink-0">
            <Button variant="ghost" size="xs" className="!font-normal h-6 w-6 px-0" title={t('settings.skills.catalog.page.actions.refreshTitle')} disabled={loadingSource !== null} onClick={() => { scanVersionRef.current += 1; setScanVersion(scanVersionRef.current); setScanError(null); setItemsBySource({}); setSelectedKeys(new Set()); setLoadedSourceIds(new Set()); setFailedSourceIds(new Set()); void refresh().catch((error) => setScanError(error instanceof Error ? error.message : t('settings.skills.catalog.page.error.catalogTitle'))); }}><Icon name="refresh" className={cn('h-3.5 w-3.5', loadingSource && 'animate-spin')} /></Button>
            {active && !searching && <Button variant="ghost" size="xs" className="!font-normal h-6 w-6 px-0" title={t('settings.providers.page.actions.edit')} onClick={() => { setEditingId(active.id); setLabel(active.label); setSource(active.source); setSubpath(active.subpath || ''); setGitIdentityId(active.gitIdentityId || null); invalidateDialogScan(); setDialogOpen(true); }}><Icon name="edit" className="h-3.5 w-3.5" /></Button>}
            {active && !searching && <Button variant="ghost" size="xs" className="!font-normal h-6 w-6 px-0 text-[var(--status-error)] hover:text-[var(--status-error)]" title={t('settings.skills.catalog.page.actions.removeCatalogTitle')} disabled={isRemoving} onClick={() => setRemoveOpen(true)}><Icon name="delete-bin" className="h-3.5 w-3.5" /></Button>}
          </div>
        </div>
        {selectableItems.length > 0 && <div className="flex items-center justify-between gap-3 pb-2">
          <div className="flex items-center gap-2 typography-meta text-muted-foreground"><Checkbox checked={allSelected} indeterminate={selectedItems.length > 0 && !allSelected} onChange={(checked) => setSelectedKeys((current) => { const next = new Set(current); for (const item of selectableItems) { if (checked) next.add(itemKey(item)); else next.delete(itemKey(item)); } return next; })} ariaLabel={t(allSelected ? 'settings.themeImport.deselectAll' : 'settings.skills.catalog.installFromRepo.actions.selectAll')} /><span>{t(allSelected ? 'settings.themeImport.deselectAll' : 'settings.skills.catalog.installFromRepo.actions.selectAll')}</span></div>
          {selectedItems.length > 0 && <div className="flex items-center gap-2"><span className="typography-meta text-muted-foreground">{t('settings.skills.catalog.installFromRepo.selectedCount', { selected: selectedItems.length, total: selectableItems.length })}</span>{selectedInstallItems.length > 0 && <Button size="xs" onClick={() => setInstallItems(selectedInstallItems)}>{t('settings.skills.catalog.installFromRepo.actions.installSelected')}</Button>}{selectedUninstallItems.length > 0 && <Button size="xs" variant="destructive" onClick={() => setUninstallItems(selectedUninstallItems)}>{t('settings.common.actions.delete')}</Button>}</div>}
        </div>}
        {(!hasLoadedCatalog || (loadingSource && filtered.length === 0)) ? <div className="py-8 text-center text-muted-foreground"><Icon name="refresh" className="mx-auto mb-3 h-5 w-5 animate-spin opacity-50" /><p className="typography-meta">{t('settings.skills.catalog.page.loading.catalog')}</p></div> : filtered.length === 0 ? <div className="py-8 text-center text-muted-foreground"><p className="typography-body">{t('settings.agents.catalog.empty')}</p><p className="typography-meta mt-1 opacity-75">{t('settings.skills.catalog.page.empty.noSkillsDescription')}</p></div> : <div className="divide-y divide-[var(--surface-subtle)]">{filtered.map((item) => {
          const installed = isInstalled(item);
          const url = githubUrl(item);
          return <div key={itemKey(item)} className="py-2"><div className="flex items-start justify-between gap-4">
            <Checkbox checked={selectedKeys.has(itemKey(item))} onChange={(checked) => setSelectedKeys((current) => { const next = new Set(current); if (checked && selectedItems.length && batchSource !== item.sourceId) return current; if (checked) next.add(itemKey(item)); else next.delete(itemKey(item)); return next; })} disabled={(installed && !isRemovable(item)) || Boolean(selectedItems.length && batchSource !== item.sourceId)} ariaLabel={`${installed ? t('settings.common.actions.delete') : t('settings.skills.catalog.shared.actions.install')} ${item.name}`} className="mt-1" />
            <div className="min-w-0 flex-1"><div className="flex items-center gap-2"><span className="typography-ui-label font-medium text-foreground truncate">{item.name}</span>{installed && <span className="typography-micro text-[var(--status-success)] bg-[var(--status-success)]/10 px-1.5 py-0.5 rounded flex-shrink-0">{t('settings.agents.catalog.installed')}</span>}</div><div className="typography-meta text-muted-foreground mt-0.5 line-clamp-2">{item.description || t('settings.skills.catalog.shared.noDescription')}</div><div className="typography-micro text-muted-foreground/80 mt-1 flex items-center gap-2 min-w-0">{url ? <a href={url} target="_blank" rel="noreferrer" className="font-mono hover:underline truncate inline-flex items-center gap-1"><Icon name="github" className="h-3 w-3 shrink-0" />{item.source}</a> : <span className="font-mono truncate">{item.source}</span>}<span className="opacity-40">·</span><span className="truncate">{item.agentPath}</span></div></div>
            <div className="flex items-center gap-1.5 shrink-0">{url && <Button variant="ghost" size="xs" className="!font-normal h-6 w-6 px-0" onClick={() => window.open(url, '_blank', 'noreferrer')} title={t('settings.skills.catalog.page.source.viewRepo')}><Icon name="external-link" className="h-3.5 w-3.5" /></Button>}{installed ? <Button variant="ghost" size="xs" className="!font-normal h-7 w-7 px-0 text-[var(--status-success)] hover:text-[var(--status-error)]" title={t('settings.common.actions.delete')} disabled={!installedAgents.some((agent) => agent.name === item.name && !isAgentBuiltIn(agent))} onClick={() => setUninstallItems([item])}><Icon name="check" className="h-4 w-4" /></Button> : <Button variant="outline" size="xs" className="!font-normal" onClick={() => setInstallItems([item])}>{t('settings.skills.catalog.shared.actions.install')}</Button>}</div>
          </div></div>;
        })}</div>}
      </SettingsSection>
    </SettingsPageLayout>
    <Dialog open={installItems.length > 0} onOpenChange={(open: boolean) => { if (!open && !installing) setInstallItems([]); }}><DialogContent className="max-w-md"><DialogHeader><DialogTitle>{t('settings.agents.catalog.installTitle')}</DialogTitle><DialogDescription>{installItems.map((item) => item.name).join(', ')}</DialogDescription></DialogHeader>
      <div className="mt-2 space-y-3"><div className="flex flex-wrap items-center gap-2"><span className="typography-ui-label text-foreground">{t('settings.skills.catalog.installSkill.field.destination')}</span><Select value={scope} onValueChange={(value) => { if (value === 'user' || value === 'project') setScope(value); }}><SelectTrigger className="w-fit gap-1.5">{scope === 'user' ? <Icon name="user-3" className="h-3.5 w-3.5" /> : <Icon name="folder" className="h-3.5 w-3.5" />}{t(scope === 'user' ? 'settings.skills.catalog.conflicts.scope.user' : 'settings.skills.catalog.conflicts.scope.project')}</SelectTrigger><SelectContent><SelectItem value="user">{t('settings.skills.catalog.conflicts.scope.user')}</SelectItem><SelectItem value="project">{t('settings.skills.catalog.conflicts.scope.project')}</SelectItem></SelectContent></Select></div>
        {scope === 'project' && <div className="flex flex-wrap items-center gap-2"><span className="typography-ui-label text-foreground">{t('settings.skills.catalog.installSkill.field.project')}</span>{projects.length === 0 ? <span className="typography-meta text-muted-foreground">{t('settings.skills.catalog.installSkill.field.noProjects')}</span> : <Select value={resolvedProjectId || ''} onValueChange={setTargetProjectId} disabled={projects.length === 1}><SelectTrigger className="w-fit"><SelectValue placeholder={t('settings.skills.catalog.installSkill.field.chooseProjectPlaceholder')} /></SelectTrigger><SelectContent>{projects.map((project) => <SelectItem key={project.id} value={project.id}>{project.label || project.path}</SelectItem>)}</SelectContent></Select>}</div>}
      </div><DialogFooter><Button size="sm" variant="ghost" onClick={() => setInstallItems([])}>{t('settings.common.actions.cancel')}</Button><Button size="sm" disabled={Boolean(installing) || (scope === 'project' && !targetProject)} onClick={() => void install(scope, scope === 'project' ? targetProject?.path || null : directory)}>{installing ? t('settings.skills.catalog.installSkill.actions.installing') : t('settings.skills.catalog.installSkill.actions.install')}</Button></DialogFooter>
    </DialogContent></Dialog>
    <Dialog open={dialogOpen} onOpenChange={(open: boolean) => { if (!open) invalidateDialogScan(); setDialogOpen(open); }}><DialogContent className="max-w-xl"><DialogHeader><DialogTitle>{editingId ? t('settings.page.agentsCatalog.title') : t('settings.skills.catalog.add.title')}</DialogTitle><DialogDescription>{t('settings.agents.catalog.dialog.description')}</DialogDescription></DialogHeader><div className="space-y-4">
      <div className="space-y-2"><label className="typography-ui-label text-foreground">{t('settings.skills.catalog.add.field.catalogName')}</label><Input value={label} onChange={(event) => setLabel(event.target.value)} placeholder={t('settings.skills.catalog.add.field.catalogNamePlaceholder')} /></div>
      <div className="space-y-2"><label className="typography-ui-label text-foreground">{t('settings.skills.catalog.add.field.repository')}</label><Input value={source} onChange={(event) => { setSource(event.target.value); invalidateDialogScan(); }} placeholder={t('settings.skills.catalog.shared.field.repositoryPlaceholder')} /></div>
      <div className="space-y-2"><label className="typography-ui-label text-foreground">{t('settings.skills.catalog.add.field.optionalSubpath')}</label><Input value={subpath} onChange={(event) => { setSubpath(event.target.value); invalidateDialogScan(); }} placeholder={t('settings.skills.catalog.shared.field.subpathPlaceholder')} /></div>
      {identities.length > 0 && <div className="space-y-2"><span className="typography-ui-label text-foreground">{t('settings.skills.catalog.shared.auth.description')}</span><Select value={gitIdentityId || 'none'} onValueChange={(value) => { setGitIdentityId(value === 'none' ? null : value); invalidateDialogScan(); }}><SelectTrigger aria-label={t('settings.skills.catalog.shared.auth.description')} className="w-fit">{identities.find((identity) => identity.id === gitIdentityId)?.name || t('settings.gitIdentities.editor.auth.anonymous')}</SelectTrigger><SelectContent><SelectItem value="none">{t('settings.gitIdentities.editor.auth.anonymous')}</SelectItem>{identities.filter((identity) => identity.transport !== 'anonymous').map((identity) => <SelectItem key={identity.id} value={identity.id}>{identity.name}</SelectItem>)}</SelectContent></Select></div>}
      {scanCount !== null && <div className="typography-meta text-muted-foreground">{t('settings.agents.catalog.count', { count: scanCount })}</div>}
    </div><DialogFooter><Button size="sm" variant="ghost" onClick={() => setDialogOpen(false)}>{t('settings.common.actions.cancel')}</Button><Button size="sm" variant="ghost" disabled={busy || !source.trim()} onClick={() => void scanDialogSource()}><Icon name="git-repository" className="h-4 w-4" />{busy ? t('settings.skills.catalog.shared.actions.scanning') : t('settings.skills.catalog.shared.actions.scan')}</Button><Button size="sm" disabled={busy || existingCatalogs === null || !label.trim() || !source.trim() || ((!editingId || !existingCatalogs.some((catalog) => catalog.id === editingId && catalog.source === source.trim() && (catalog.subpath || '') === subpath.trim() && (catalog.gitIdentityId || null) === gitIdentityId)) && !scanOk)} onClick={() => void save()}>{editingId ? t('settings.gitIdentities.editor.actions.save') : t('settings.skills.catalog.add.actions.addCatalog')}</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={uninstallItems.length > 0} onOpenChange={(open: boolean) => { if (!open && !isRemoving) setUninstallItems([]); }}><DialogContent className="max-w-md"><DialogHeader><DialogTitle>{t('settings.agents.sidebar.dialog.deleteTitle')}</DialogTitle><DialogDescription>{uninstallItems.length === 1 ? t('settings.agents.sidebar.dialog.deleteDescription', { name: uninstallItems[0].name }) : uninstallItems.map((item) => item.name).join(', ')}</DialogDescription></DialogHeader><DialogFooter><Button size="sm" variant="ghost" onClick={() => setUninstallItems([])}>{t('settings.common.actions.cancel')}</Button><Button size="sm" variant="destructive" disabled={isRemoving} onClick={() => void uninstall()}>{t('settings.common.actions.delete')}</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={removeOpen} onOpenChange={setRemoveOpen}><DialogContent className="max-w-md"><DialogHeader><DialogTitle>{t('settings.skills.catalog.page.removeDialog.title')}</DialogTitle><DialogDescription>{t('settings.skills.catalog.page.removeDialog.description')}</DialogDescription></DialogHeader><DialogFooter><Button size="sm" variant="ghost" onClick={() => setRemoveOpen(false)}>{t('settings.common.actions.cancel')}</Button><Button size="sm" variant="destructive" disabled={isRemoving} onClick={() => void remove()}>{t('settings.skills.catalog.page.actions.removeCatalog')}</Button></DialogFooter></DialogContent></Dialog>
  </>;
};