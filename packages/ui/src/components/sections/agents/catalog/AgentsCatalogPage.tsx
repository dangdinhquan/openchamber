import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import {
  SETTINGS_SELECT_SIZE,
  SETTINGS_SELECT_TRIGGER_CLASS,
  SettingsCheckboxRow,
  SettingsSection,
  SettingsStackedField,
} from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import { useGitIdentitiesStore } from '@/stores/useGitIdentitiesStore';
import {
  installCatalogAgent,
  listAgentsCatalogSyncSources,
  removeAgentsCatalogSyncSource,
  saveAgentsCatalogSyncSource,
  scanAgentsCatalogRepository,
  syncAgentsCatalogSource,
  type AgentsCatalogItem,
  type AgentsCatalogSyncInput,
  type AgentsCatalogSyncSource,
} from './agentsCatalogApi';

const SYNC_INTERVALS = [300, 3600, 21600, 86400] as const;
type SyncInterval = typeof SYNC_INTERVALS[number];
type AgentsCatalogTab = 'browse' | 'sync';

interface AgentsCatalogPageProps {
  searchTargetId?: string | null;
}

export const AgentsCatalogPage: React.FC<AgentsCatalogPageProps> = ({ searchTargetId }) => {
  const { t } = useI18n();
  const [activeTab, setActiveTab] = React.useState<AgentsCatalogTab>('browse');
  const browseTabRef = React.useRef<HTMLButtonElement>(null);
  const syncTabRef = React.useRef<HTMLButtonElement>(null);
  const [sourceName, setSourceName] = React.useState('');
  const [source, setSource] = React.useState('');
  const [repositoryPath, setRepositoryPath] = React.useState('');
  const [ref, setRef] = React.useState('');
  const [gitIdentityId, setGitIdentityId] = React.useState('');
  const [catalogSource, setCatalogSource] = React.useState('');
  const [catalogRepositoryPath, setCatalogRepositoryPath] = React.useState('');
  const [catalogRef, setCatalogRef] = React.useState('');
  const [catalogGitIdentityId, setCatalogGitIdentityId] = React.useState('');
  const [syncInterval, setSyncInterval] = React.useState<SyncInterval>(3600);
  const [autoSync, setAutoSync] = React.useState(true);
  const [overrideCustomizedAgents, setOverrideCustomizedAgents] = React.useState(false);
  const [editingSourceId, setEditingSourceId] = React.useState<string | null>(null);
  const [sourceFormOpen, setSourceFormOpen] = React.useState(false);
  const [sourceToRemove, setSourceToRemove] = React.useState<AgentsCatalogSyncSource | null>(null);
  const [deleteSyncedAgents, setDeleteSyncedAgents] = React.useState(false);
  const [isRemovingSource, setIsRemovingSource] = React.useState(false);
  const [sources, setSources] = React.useState<AgentsCatalogSyncSource[]>([]);
  const [sourcesLoadFailed, setSourcesLoadFailed] = React.useState(false);
  const [items, setItems] = React.useState<AgentsCatalogItem[] | null>(null);
  const [skippedFiles, setSkippedFiles] = React.useState(0);
  const [isScanning, setIsScanning] = React.useState(false);
  const [isSavingSource, setIsSavingSource] = React.useState(false);
  const [syncingSourceId, setSyncingSourceId] = React.useState<string | null>(null);
  const [installingPath, setInstallingPath] = React.useState<string | null>(null);
  const [installedPaths, setInstalledPaths] = React.useState<Set<string>>(() => new Set());

  const profiles = useGitIdentitiesStore((state) => state.profiles);
  const loadProfiles = useGitIdentitiesStore((state) => state.loadProfiles);

  React.useEffect(() => {
    void loadProfiles();
  }, [loadProfiles]);

  const refreshSources = React.useCallback(async () => {
    const nextSources = await listAgentsCatalogSyncSources();
    setSources(nextSources);
    setSourcesLoadFailed(false);
  }, []);

  React.useEffect(() => {
    void refreshSources().catch(() => setSourcesLoadFailed(true));
  }, [refreshSources]);

  React.useEffect(() => {
    if (searchTargetId === 'agents.catalog.sync.sources') {
      setActiveTab('sync');
    } else if (searchTargetId === 'agents.catalog.source') {
      setActiveTab('browse');
    }
  }, [searchTargetId]);

  const handleTabKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    const nextTab = event.key === 'Home' || (event.key === 'ArrowLeft' && activeTab === 'sync')
      ? 'browse'
      : event.key === 'End' || (event.key === 'ArrowRight' && activeTab === 'browse')
        ? 'sync'
        : activeTab;
    setActiveTab(nextTab);
    (nextTab === 'browse' ? browseTabRef : syncTabRef).current?.focus();
  };

  const resetSourceForm = () => {
    setSourceName('');
    setSource('');
    setRepositoryPath('');
    setRef('');
    setGitIdentityId('');
    setSyncInterval(3600);
    setAutoSync(true);
    setOverrideCustomizedAgents(false);
    setEditingSourceId(null);
    setSourceFormOpen(false);
  };

  const handleAddSource = () => {
    resetSourceForm();
    setSourceFormOpen(true);
  };

  const handleSaveSource = async () => {
    setIsSavingSource(true);
    const input: AgentsCatalogSyncInput = {
      name: sourceName.trim() || source.trim(),
      source: source.trim(),
      path: repositoryPath.trim(),
      ref: ref.trim(),
      gitIdentityId: gitIdentityId || null,
      intervalSeconds: syncInterval,
      autoSync,
      overrideCustomizedAgents,
    };
    let saved: AgentsCatalogSyncSource;
    try {
      saved = await saveAgentsCatalogSyncSource(input, editingSourceId);
    } catch (error) {
      const kind = error instanceof Error ? error.message : 'unknown';
      toast.error(kind === 'authRequired'
        ? t('settings.agents.catalog.sync.toast.authenticationRequired')
        : t('settings.agents.catalog.sync.toast.saveFailed'));
      await refreshSources().catch(() => setSourcesLoadFailed(true));
      setIsSavingSource(false);
      return;
    }
    setEditingSourceId(null);
    setSourceFormOpen(false);
    try {
      const result = await syncAgentsCatalogSource(saved.id);
      if (result.status === 'synced') {
        toast.success(t('settings.agents.catalog.sync.toast.synced', { name: saved.name }));
      } else {
        toast.error(t('settings.agents.catalog.sync.toast.syncFailed'));
      }
    } catch (error) {
      const kind = error instanceof Error ? error.message : 'unknown';
      toast.error(kind === 'authRequired'
        ? t('settings.agents.catalog.sync.toast.authenticationRequired')
        : t('settings.agents.catalog.sync.toast.syncFailed'));
    } finally {
      await refreshSources().catch(() => setSourcesLoadFailed(true));
      setIsSavingSource(false);
    }
  };

  const handleEditSource = (saved: AgentsCatalogSyncSource) => {
    setSourceName(saved.name);
    setSource(saved.source);
    setRepositoryPath(saved.path);
    setRef(saved.ref);
    setGitIdentityId(saved.gitIdentityId ?? '');
    setSyncInterval(saved.intervalSeconds);
    setAutoSync(saved.autoSync);
    setOverrideCustomizedAgents(saved.overrideCustomizedAgents);
    setEditingSourceId(saved.id);
    setSourceFormOpen(true);
  };

  const handleSyncSource = async (saved: AgentsCatalogSyncSource) => {
    setSyncingSourceId(saved.id);
    try {
      const result = await syncAgentsCatalogSource(saved.id);
      if (result.status === 'synced') {
        toast.success(t('settings.agents.catalog.sync.toast.synced', { name: saved.name }));
      } else {
        toast.error(t('settings.agents.catalog.sync.toast.syncFailed'));
      }
    } catch (error) {
      const kind = error instanceof Error ? error.message : 'unknown';
      toast.error(kind === 'authRequired'
        ? t('settings.agents.catalog.sync.toast.authenticationRequired')
        : t('settings.agents.catalog.sync.toast.syncFailed'));
    } finally {
      await refreshSources().catch(() => setSourcesLoadFailed(true));
      setSyncingSourceId(null);
    }
  };

  const handleToggleAutoSync = async (saved: AgentsCatalogSyncSource) => {
    try {
      await saveAgentsCatalogSyncSource({
        name: saved.name,
        source: saved.source,
        path: saved.path,
        ref: saved.ref,
        gitIdentityId: saved.gitIdentityId,
        intervalSeconds: saved.intervalSeconds,
        autoSync: !saved.autoSync,
        overrideCustomizedAgents: saved.overrideCustomizedAgents,
      }, saved.id);
    } catch {
      toast.error(t('settings.agents.catalog.sync.toast.saveFailed'));
      return;
    }
    await refreshSources().catch(() => setSourcesLoadFailed(true));
  };

  const handleRemoveSource = async () => {
    if (!sourceToRemove) return;
    setIsRemovingSource(true);
    try {
      await removeAgentsCatalogSyncSource(sourceToRemove.id, deleteSyncedAgents);
      setSources((current) => current.filter((sourceItem) => sourceItem.id !== sourceToRemove.id));
      if (editingSourceId === sourceToRemove.id) resetSourceForm();
      toast.success(deleteSyncedAgents
        ? t('settings.agents.catalog.sync.toast.removedWithAgents', { name: sourceToRemove.name })
        : t('settings.agents.catalog.sync.toast.removed', { name: sourceToRemove.name }));
      setSourceToRemove(null);
    } catch {
      toast.error(t('settings.agents.catalog.sync.toast.removeFailed'));
    } finally {
      setIsRemovingSource(false);
    }
  };

  const intervalLabel = (seconds: SyncInterval) => {
    switch (seconds) {
      case 300:
        return t('settings.agents.catalog.sync.interval.300');
      case 3600:
        return t('settings.agents.catalog.sync.interval.3600');
      case 21600:
        return t('settings.agents.catalog.sync.interval.21600');
      case 86400:
        return t('settings.agents.catalog.sync.interval.86400');
    }
  };

  const handleScan = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsScanning(true);
    setItems(null);
    setInstalledPaths(new Set());
    try {
      const result = await scanAgentsCatalogRepository({
        source: catalogSource.trim(),
        path: catalogRepositoryPath.trim(),
        ref: catalogRef.trim(),
        gitIdentityId: catalogGitIdentityId || null,
      });
      setItems(result.items);
      setSkippedFiles(result.skippedFiles);
    } catch (error) {
      const kind = error instanceof Error ? error.message : 'unknown';
      toast.error(kind === 'authRequired'
        ? t('settings.agents.catalog.toast.authenticationRequiredScan')
        : t('settings.agents.catalog.toast.scanFailed'));
      setItems(null);
    } finally {
      setIsScanning(false);
    }
  };

  const handleInstall = async (item: AgentsCatalogItem) => {
    setInstallingPath(item.path);
    try {
      await installCatalogAgent({
        source: catalogSource.trim(),
        path: catalogRepositoryPath.trim(),
        ref: catalogRef.trim(),
        agentPath: item.path,
        gitIdentityId: catalogGitIdentityId || null,
      });
      setInstalledPaths((current) => new Set(current).add(item.path));
      toast.success(t('settings.agents.catalog.toast.installed', { name: item.name }));
    } catch (error) {
      const kind = error instanceof Error ? error.message : 'unknown';
      toast.error(kind === 'conflict'
        ? t('settings.agents.catalog.toast.conflict', { name: item.name })
        : kind === 'authRequired'
          ? t('settings.agents.catalog.toast.authenticationRequiredInstall')
          : t('settings.agents.catalog.toast.installFailed'));
    } finally {
      setInstallingPath(null);
    }
  };

  return (
    <SettingsPageLayout
      title={t('settings.page.agentsCatalog.title')}
      description={t('settings.page.agentsCatalog.description')}
      showSaveStatus={false}
    >
      <div
        className="mb-4 flex flex-wrap gap-2"
        role="tablist"
        aria-label={t('settings.page.agentsCatalog.title')}
        onKeyDown={handleTabKeyDown}
      >
        <Button
          id="agents-catalog-browse-tab"
          ref={browseTabRef}
          role="tab"
          aria-selected={activeTab === 'browse'}
          aria-controls="agents-catalog-browse-panel"
          tabIndex={activeTab === 'browse' ? 0 : -1}
          variant={activeTab === 'browse' ? 'secondary' : 'ghost'}
          size="sm"
          onClick={() => setActiveTab('browse')}
        >
          {t('settings.agents.catalog.scan.title')}
        </Button>
        <Button
          id="agents-catalog-sync-tab"
          ref={syncTabRef}
          role="tab"
          aria-selected={activeTab === 'sync'}
          aria-controls="agents-catalog-sync-panel"
          tabIndex={activeTab === 'sync' ? 0 : -1}
          variant={activeTab === 'sync' ? 'secondary' : 'ghost'}
          size="sm"
          onClick={() => setActiveTab('sync')}
        >
          {t('settings.agents.catalog.sync.title')}
        </Button>
      </div>
      <div
        id="agents-catalog-browse-panel"
        role="tabpanel"
        aria-labelledby="agents-catalog-browse-tab"
        tabIndex={0}
        hidden={activeTab !== 'browse'}
      >
      <SettingsSection divider={false} settingsItem="agents.catalog.source">
        <form onSubmit={(event) => void handleScan(event)} className="space-y-4">
          <div className="grid grid-cols-1 gap-4 @3xl:grid-cols-2">
            <SettingsStackedField label={t('settings.agents.catalog.field.repository')}>
              <Input
                value={catalogSource}
                onChange={(event) => setCatalogSource(event.target.value)}
                placeholder={t('settings.agents.catalog.field.repositoryPlaceholder')}
                className="h-8 rounded-md px-3"
                required
              />
            </SettingsStackedField>
            <SettingsStackedField
              label={t('settings.agents.catalog.field.path')}
              info={t('settings.agents.catalog.field.pathInfo')}
            >
              <Input
                value={catalogRepositoryPath}
                onChange={(event) => setCatalogRepositoryPath(event.target.value)}
                placeholder={t('settings.agents.catalog.field.pathPlaceholder')}
                className="h-8 rounded-md px-3 placeholder:italic"
              />
            </SettingsStackedField>
            <SettingsStackedField
              label={t('settings.agents.catalog.field.ref')}
              info={t('settings.agents.catalog.field.refInfo')}
            >
              <Input
                value={catalogRef}
                onChange={(event) => setCatalogRef(event.target.value)}
                placeholder={t('settings.agents.catalog.field.refPlaceholder')}
                className="h-8 rounded-md px-3"
              />
            </SettingsStackedField>
            {profiles.length > 0 && (
              <SettingsStackedField
                label={t('settings.agents.catalog.field.gitIdentity')}
                info={t('settings.agents.catalog.field.gitIdentityInfo')}
              >
                <Select value={catalogGitIdentityId || 'default'} onValueChange={(value) => setCatalogGitIdentityId(value === 'default' ? '' : value)}>
                  <SelectTrigger size={SETTINGS_SELECT_SIZE} className={SETTINGS_SELECT_TRIGGER_CLASS} aria-label={t('settings.agents.catalog.field.gitIdentity')}>
                    <SelectValue>
                      {(value) => value === 'default'
                        ? t('settings.agents.catalog.identity.default')
                        : profiles.find((profile) => profile.id === value)?.name ?? value}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="default">{t('settings.agents.catalog.identity.default')}</SelectItem>
                    {profiles.map((profile) => (
                      <SelectItem key={profile.id} value={profile.id}>{profile.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </SettingsStackedField>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" disabled={isScanning || isSavingSource || catalogSource.trim().length === 0}>
              {isScanning
                ? t('settings.agents.catalog.scan.action.scanning')
                : t('settings.agents.catalog.scan.action.scan')}
            </Button>
          </div>
        </form>
      </SettingsSection>
      </div>

      <div
        id="agents-catalog-sync-panel"
        role="tabpanel"
        aria-labelledby="agents-catalog-sync-tab"
        tabIndex={0}
        hidden={activeTab !== 'sync'}
      >
      <SettingsSection
        divider={false}
        headerAction={(
          <Button size="sm" onClick={handleAddSource}>
            <Icon name="add" className="size-4" />
            {t('settings.agents.catalog.sync.action.new')}
          </Button>
        )}
        settingsItem="agents.catalog.sync.sources"
      >
        <p className="mb-4 typography-meta text-muted-foreground">
          {t('settings.agents.catalog.sync.description')}
        </p>
        {sourcesLoadFailed ? (
          <p className="typography-meta text-[var(--status-error-text)]">
            {t('settings.agents.catalog.sync.loadFailed')}
          </p>
        ) : sources.length === 0 ? (
          <p className="typography-meta text-muted-foreground">{t('settings.agents.catalog.sync.empty')}</p>
        ) : (
          <div className="space-y-5">
            {sources.map((saved) => {
              const syncing = syncingSourceId === saved.id;
              const summary = saved.lastSummary;
              return (
                <article key={saved.id} className="flex min-w-0 flex-col gap-3 border-b border-border pb-4 last:border-b-0 last:pb-0">
                  <div className="min-w-0">
                    <h3 className="typography-ui-label font-medium text-foreground">{saved.name}</h3>
                    <p className="mt-1 typography-micro font-mono text-muted-foreground break-all">
                      {saved.source} · {saved.path || t('settings.agents.catalog.field.pathPlaceholder')}
                    </p>
                    <p className="mt-1 typography-meta text-muted-foreground">
                      {saved.status === 'error'
                        ? t('settings.agents.catalog.sync.status.error')
                        : saved.status === 'synced'
                          ? t('settings.agents.catalog.sync.status.synced')
                          : t('settings.agents.catalog.sync.status.pending')}
                      {' · '}
                      {saved.autoSync
                        ? intervalLabel(saved.intervalSeconds)
                        : t('settings.agents.catalog.sync.status.paused')}
                    </p>
                    {summary && (
                      <p className="mt-1 typography-micro text-muted-foreground">
                        {t('settings.agents.catalog.sync.summary.result', {
                          updated: summary.updated,
                          conflicts: summary.conflicts,
                          skipped: summary.skipped,
                          failed: summary.failed,
                        })}
                      </p>
                    )}
                    {saved.lastError && (
                      <p className="mt-1 typography-micro text-[var(--status-error-text)]">
                        {t('settings.agents.catalog.sync.summary.lastError')}
                      </p>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button size="xs" disabled={syncing || isSavingSource} onClick={() => void handleSyncSource(saved)}>
                      {syncing
                        ? t('settings.agents.catalog.sync.action.syncing')
                        : t('settings.agents.catalog.sync.action.syncNow')}
                    </Button>
                    <Button size="xs" variant="outline" disabled={isSavingSource} onClick={() => handleEditSource(saved)}>
                      {t('settings.agents.catalog.sync.action.edit')}
                    </Button>
                    <Button size="xs" variant="ghost" disabled={isSavingSource} onClick={() => void handleToggleAutoSync(saved)}>
                      {saved.autoSync
                        ? t('settings.agents.catalog.sync.action.pause')
                        : t('settings.agents.catalog.sync.action.resume')}
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={isSavingSource || isRemovingSource}
                      onClick={() => {
                        setDeleteSyncedAgents(false);
                        setSourceToRemove(saved);
                      }}
                    >
                      {t('settings.agents.catalog.sync.action.remove')}
                    </Button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </SettingsSection>
      </div>

      <div role="region" aria-labelledby="agents-catalog-browse-tab" hidden={activeTab !== 'browse'}>
      {items !== null && (
        <SettingsSection
          title={t('settings.agents.catalog.section.results')}
          settingsItem="agents.catalog.results"
        >
          {skippedFiles > 0 && (
            <p className="mb-3 typography-meta text-[var(--status-warning-text)]">
              {skippedFiles === 1
                ? t('settings.agents.catalog.skipped.single')
                : t('settings.agents.catalog.skipped.multiple', { count: skippedFiles })}
            </p>
          )}
          {items.length === 0 ? (
            <p className="typography-meta text-muted-foreground">{t('settings.agents.catalog.empty')}</p>
          ) : (
            <div className="grid grid-cols-1 gap-3 @3xl:grid-cols-2">
              {items.map((item) => {
                const installed = installedPaths.has(item.path);
                const busy = installingPath === item.path;
                return (
                  <article
                    key={item.path}
                    className="oc-surface-elevated flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-surface-elevated p-4"
                  >
                    <div className="min-w-0">
                      <h3 className="typography-ui-label font-medium text-foreground">{item.name}</h3>
                      <p className="mt-1 typography-micro font-mono text-muted-foreground break-all">{item.path}</p>
                      <p className="mt-2 typography-meta text-muted-foreground">
                        {item.description || t('settings.agents.catalog.item.noDescription')}
                      </p>
                    </div>
                    <div>
                      <Button
                        size="sm"
                        variant={installed ? 'secondary' : 'default'}
                        disabled={!item.installable || installed || installingPath !== null}
                        onClick={() => void handleInstall(item)}
                      >
                        {busy
                            ? t('settings.agents.catalog.scan.action.installing')
                          : installed
                            ? t('settings.agents.catalog.action.installed')
                              : t('settings.agents.catalog.scan.action.install')}
                      </Button>
                      {!item.installable && (
                        <span className="ml-2 inline-flex items-center gap-1 typography-micro text-[var(--status-warning-text)]">
                          <Icon name="error-warning" className="size-3" />
                          {t('settings.agents.catalog.item.invalidName')}
                        </span>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </SettingsSection>
      )}
      </div>

      <Dialog open={sourceFormOpen} onOpenChange={setSourceFormOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editingSourceId
                ? t('settings.agents.catalog.sync.dialog.editTitle')
                : t('settings.agents.catalog.sync.dialog.newTitle')}
            </DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void handleSaveSource();
            }}
            className="space-y-4"
          >
            <div className="space-y-4">
              <SettingsStackedField label={t('settings.agents.catalog.sync.field.name')}>
                <Input
                  value={sourceName}
                  onChange={(event) => setSourceName(event.target.value)}
                  placeholder={t('settings.agents.catalog.sync.field.namePlaceholder')}
                  className="h-8 rounded-md px-3"
                />
              </SettingsStackedField>
              <SettingsStackedField label={t('settings.agents.catalog.field.repository')}>
                <Input
                  value={source}
                  onChange={(event) => setSource(event.target.value)}
                  placeholder={t('settings.agents.catalog.field.repositoryPlaceholder')}
                  className="h-8 rounded-md px-3"
                  required
                />
              </SettingsStackedField>
              <SettingsStackedField
                label={t('settings.agents.catalog.field.path')}
                info={t('settings.agents.catalog.field.pathInfo')}
              >
                <Input
                  value={repositoryPath}
                  onChange={(event) => setRepositoryPath(event.target.value)}
                  placeholder={t('settings.agents.catalog.field.pathPlaceholder')}
                  className="h-8 rounded-md px-3 placeholder:italic"
                />
              </SettingsStackedField>
              <SettingsStackedField
                label={t('settings.agents.catalog.field.ref')}
                info={t('settings.agents.catalog.field.refInfo')}
              >
                <Input
                  value={ref}
                  onChange={(event) => setRef(event.target.value)}
                  placeholder={t('settings.agents.catalog.field.refPlaceholder')}
                  className="h-8 rounded-md px-3"
                />
              </SettingsStackedField>
              {profiles.length > 0 && (
                <SettingsStackedField
                  label={t('settings.agents.catalog.field.gitIdentity')}
                  info={t('settings.agents.catalog.field.gitIdentityInfo')}
                >
                  <Select
                    value={gitIdentityId || 'default'}
                    onValueChange={(value) => setGitIdentityId(value === 'default' ? '' : value)}
                  >
                    <SelectTrigger
                      size={SETTINGS_SELECT_SIZE}
                      className={SETTINGS_SELECT_TRIGGER_CLASS}
                      aria-label={t('settings.agents.catalog.field.gitIdentity')}
                    >
                      <SelectValue>
                        {(value) => value === 'default'
                          ? t('settings.agents.catalog.identity.default')
                          : profiles.find((profile) => profile.id === value)?.name ?? value}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="default">{t('settings.agents.catalog.identity.default')}</SelectItem>
                      {profiles.map((profile) => (
                        <SelectItem key={profile.id} value={profile.id}>{profile.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </SettingsStackedField>
              )}
              <SettingsStackedField
                label={t('settings.agents.catalog.sync.field.interval')}
                settingsItem="agents.catalog.sync.interval"
              >
                <Select
                  value={String(syncInterval)}
                  onValueChange={(value) => {
                    const selected = SYNC_INTERVALS.find((interval) => String(interval) === value);
                    if (selected !== undefined) setSyncInterval(selected);
                  }}
                >
                  <SelectTrigger size={SETTINGS_SELECT_SIZE} className={SETTINGS_SELECT_TRIGGER_CLASS}>
                    <SelectValue>
                      {(value) => {
                        const selected = SYNC_INTERVALS.find((interval) => String(interval) === value);
                        return selected === undefined ? value : intervalLabel(selected);
                      }}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {SYNC_INTERVALS.map((interval) => (
                      <SelectItem key={interval} value={String(interval)}>{intervalLabel(interval)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </SettingsStackedField>
            </div>
            <div className="space-y-1.5">
              <SettingsCheckboxRow
                checked={autoSync}
                onChange={setAutoSync}
                label={t('settings.agents.catalog.sync.field.autoSync')}
                info={t('settings.agents.catalog.sync.field.autoSyncInfo')}
                settingsItem="agents.catalog.sync.auto"
              />
              <SettingsCheckboxRow
                checked={overrideCustomizedAgents}
                onChange={setOverrideCustomizedAgents}
                label={t('settings.agents.catalog.sync.field.overrideCustomized')}
                info={t('settings.agents.catalog.sync.field.overrideCustomizedInfo')}
                settingsItem="agents.catalog.sync.override"
              />
            </div>
            <DialogFooter>
              <Button type="button" size="sm" variant="outline" onClick={resetSourceForm} disabled={isSavingSource}>
                {t('settings.agents.catalog.sync.action.cancel')}
              </Button>
              <Button type="submit" size="sm" disabled={isSavingSource || isScanning}>
                {isSavingSource
                  ? t('settings.agents.catalog.sync.action.saving')
                  : editingSourceId
                    ? t('settings.agents.catalog.sync.action.save')
                    : t('settings.agents.catalog.sync.action.add')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={sourceToRemove !== null}
        onOpenChange={(open) => {
          if (!open && !isRemovingSource) setSourceToRemove(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('settings.agents.catalog.sync.dialog.removeTitle')}</DialogTitle>
            <DialogDescription>
              {t('settings.agents.catalog.sync.dialog.removeDescription', {
                name: sourceToRemove?.name ?? '',
              })}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <p className="typography-meta text-[var(--status-warning-text)]">
              {t('settings.agents.catalog.sync.dialog.removeWarning')}
            </p>
            <SettingsCheckboxRow
              checked={deleteSyncedAgents}
              onChange={setDeleteSyncedAgents}
              label={t('settings.agents.catalog.sync.dialog.deleteSyncedAgents')}
            />
          </div>
          <DialogFooter>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setSourceToRemove(null)}
              disabled={isRemovingSource}
            >
              {t('settings.agents.catalog.sync.action.cancel')}
            </Button>
            <Button
              size="sm"
              variant="destructive"
              onClick={() => void handleRemoveSource()}
              disabled={isRemovingSource}
            >
              {isRemovingSource
                ? t('settings.agents.catalog.sync.action.removing')
                : t('settings.agents.catalog.sync.action.remove')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </SettingsPageLayout>
  );
};
