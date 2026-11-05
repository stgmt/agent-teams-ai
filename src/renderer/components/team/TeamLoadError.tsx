import { useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { Button } from '@renderer/components/ui/button';
import { useStore } from '@renderer/store';

import { SpecRegistryConnectionDialog } from './dialogs/SpecRegistryConnectionDialog';

interface TeamLoadErrorProps {
  teamName: string;
  error: string;
  onRetry(): void;
}

/** Connect or change a team's specification without loading its task board. */
export function SpecRegistryConnectButton({
  teamName,
  onSaved,
  className,
}: {
  teamName: string;
  onSaved(): void;
  className?: string;
}): React.JSX.Element {
  const { t } = useAppTranslation('team');
  const summary = useStore((state) => state.teamByName[teamName]);
  const [connecting, setConnecting] = useState(false);
  return (
    <>
      <Button className={className} variant="outline" onClick={() => setConnecting(true)}>
        {t('create.registryPicker.connectTitle')}
      </Button>
      {connecting ? (
        <SpecRegistryConnectionDialog
          teamName={teamName}
          initialProject={summary?.specProject}
          initialSpec={summary?.specSlug}
          onClose={() => setConnecting(false)}
          onSaved={() => {
            setConnecting(false);
            onSaved();
          }}
        />
      ) : null}
    </>
  );
}

/** Allows a team without registry binding to be repaired without opening its task board. */
export function TeamLoadError({ teamName, error, onRetry }: TeamLoadErrorProps): React.JSX.Element {
  const { t } = useAppTranslation('team');
  return (
    <div className="flex size-full items-center justify-center p-6">
      <div className="text-center">
        <p className="text-sm font-medium text-red-400">{t('detail.loadFailed')}</p>
        <p className="mt-2 text-xs text-[var(--color-text-muted)]">{error}</p>
        <SpecRegistryConnectButton className="mt-4" teamName={teamName} onSaved={onRetry} />
      </div>
    </div>
  );
}
