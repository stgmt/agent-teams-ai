import { useAppTranslation } from '@features/localization/renderer';
import { Button } from '@renderer/components/ui/button';

import { SpecRegistryConnectionDialog } from './SpecRegistryConnectionDialog';
import { SpecRegistryPicker } from './SpecRegistryPicker';

import type { CreateTeamIntegrationState } from './createTeamIntegrationState';

interface CreateTeamSpecIntegrationFieldsProps {
  integration: CreateTeamIntegrationState;
  disabled: boolean;
  showFields: boolean;
  showSetup: boolean;
}

/** Reuses registry discovery and credential onboarding without owning another draft or connection. */
export const CreateTeamSpecIntegrationFields = ({
  integration,
  disabled,
  showFields,
  showSetup,
}: CreateTeamSpecIntegrationFieldsProps): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  return (
    <>
      {integration.setupOpen && showSetup && (
        <SpecRegistryConnectionDialog
          onClose={() => integration.setSetupOpen(false)}
          onSaved={integration.onSetupSaved}
        />
      )}
      {showFields && (
        <>
          <SpecRegistryPicker
            key={integration.revision}
            project={integration.project}
            slug={integration.slug}
            onProjectChange={integration.onProjectChange}
            onSlugChange={integration.onSlugChange}
            onValidSelectionChange={integration.onValidSelectionChange}
            disabled={disabled}
            allowEmptySelection
          />
          <div className="flex flex-wrap items-center justify-between gap-2 md:col-span-2">
            <p className="text-xs text-[var(--color-text-muted)]">
              {t('create.registryPicker.optionalBinding')}
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled}
              onClick={() => integration.setSetupOpen(true)}
            >
              {t('create.registryPicker.connectAction')}
            </Button>
            {integration.hasBinding ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={disabled}
                onClick={integration.clearBinding}
              >
                {t('create.registryPicker.clearBinding')}
              </Button>
            ) : null}
          </div>
        </>
      )}
    </>
  );
};
