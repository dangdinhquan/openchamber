import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui';
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
  SettingsSection,
  SettingsStackedField,
} from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import { useGitIdentitiesStore } from '@/stores/useGitIdentitiesStore';
import { installCatalogAgent, scanAgentsCatalogRepository, type AgentsCatalogItem } from './agentsCatalogApi';

export const AgentsCatalogPage: React.FC = () => {
  const { t } = useI18n();
  const [source, setSource] = React.useState('');
  const [repositoryPath, setRepositoryPath] = React.useState('agents');
  const [ref, setRef] = React.useState('');
  const [gitIdentityId, setGitIdentityId] = React.useState('');
  const [items, setItems] = React.useState<AgentsCatalogItem[] | null>(null);
  const [skippedFiles, setSkippedFiles] = React.useState(0);
  const [isScanning, setIsScanning] = React.useState(false);
  const [installingPath, setInstallingPath] = React.useState<string | null>(null);
  const [installedPaths, setInstalledPaths] = React.useState<Set<string>>(() => new Set());

  const profiles = useGitIdentitiesStore((state) => state.profiles);
  const loadProfiles = useGitIdentitiesStore((state) => state.loadProfiles);

  React.useEffect(() => {
    void loadProfiles();
  }, [loadProfiles]);

  const handleScan = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsScanning(true);
    setItems(null);
    setInstalledPaths(new Set());
    try {
      const result = await scanAgentsCatalogRepository({
        source: source.trim(),
        path: repositoryPath.trim(),
        ref: ref.trim(),
        gitIdentityId: gitIdentityId || null,
      });
      setItems(result.items);
      setSkippedFiles(result.skippedFiles);
    } catch (error) {
      const kind = error instanceof Error ? error.message : 'unknown';
      toast.error(kind === 'authRequired'
        ? t('settings.skills.catalog.installFromRepo.toast.authenticationRequiredScan')
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
        source: source.trim(),
        path: repositoryPath.trim(),
        ref: ref.trim(),
        agentPath: item.path,
        gitIdentityId: gitIdentityId || null,
      });
      setInstalledPaths((current) => new Set(current).add(item.path));
      toast.success(t('settings.agents.catalog.toast.installed', { name: item.name }));
    } catch (error) {
      const kind = error instanceof Error ? error.message : 'unknown';
      toast.error(kind === 'conflict'
        ? t('settings.agents.catalog.toast.conflict', { name: item.name })
        : kind === 'authRequired'
          ? t('settings.skills.catalog.installFromRepo.toast.authenticationRequiredInstall')
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
      <SettingsSection
        title={t('settings.skills.catalog.installFromRepo.title')}
        divider={false}
        settingsItem="agents.catalog.source"
      >
        <form onSubmit={(event) => void handleScan(event)} className="space-y-4">
          <div className="grid grid-cols-1 gap-4 @3xl:grid-cols-2">
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
                className="h-8 rounded-md px-3"
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
                <Select value={gitIdentityId || 'default'} onValueChange={(value) => setGitIdentityId(value === 'default' ? '' : value)}>
                  <SelectTrigger size={SETTINGS_SELECT_SIZE} className={SETTINGS_SELECT_TRIGGER_CLASS} aria-label={t('settings.agents.catalog.field.gitIdentity')}>
                    <SelectValue />
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
          <Button type="submit" size="sm" disabled={isScanning}>
            {isScanning
              ? t('settings.skills.catalog.shared.actions.scanning')
              : t('settings.skills.catalog.shared.actions.scan')}
          </Button>
        </form>
      </SettingsSection>

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
                          ? t('settings.skills.catalog.shared.actions.installing')
                          : installed
                            ? t('settings.agents.catalog.action.installed')
                            : t('settings.skills.catalog.shared.actions.install')}
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

    </SettingsPageLayout>
  );
};
