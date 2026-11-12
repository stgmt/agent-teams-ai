import { useAppTranslation } from '@features/localization/renderer';
import { Checkbox } from '@renderer/components/ui/checkbox';
import { Label } from '@renderer/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select';

import {
  getOrganizationPlacementUnitKindKey,
  getOrganizationUnitLabel,
} from './createTeamOrganizationPlacement';

import type { OrganizationPlacementUnitOption } from './createTeamOrganizationPlacement';
import type {
  OrganizationStructureUnitDto,
  OrganizationSummaryDto,
} from '@features/organizations/contracts';

interface CreateTeamOrganizationPlacementFieldsProps {
  organizationPlacementEnabled: boolean;
  organizationStructureLoading: boolean;
  organizationPlacementError: string | null;
  organizationPlacementOrganizations: OrganizationSummaryDto[];
  activePlacementOrganization: OrganizationSummaryDto | null;
  organizationPlacementParentOptions: OrganizationPlacementUnitOption[];
  activePlacementParent: OrganizationStructureUnitDto | null;
  setOrganizationPlacementEnabled: (enabled: boolean) => void;
  setOrganizationPlacementOrganizationId: (id: string) => void;
  setOrganizationPlacementParentId: (id: string) => void;
}

/** Controlled placement controls; draft persistence and selection validation stay in the create flow. */
export const CreateTeamOrganizationPlacementFields = ({
  organizationPlacementEnabled,
  organizationStructureLoading,
  organizationPlacementError,
  organizationPlacementOrganizations,
  activePlacementOrganization,
  organizationPlacementParentOptions,
  activePlacementParent,
  setOrganizationPlacementEnabled,
  setOrganizationPlacementOrganizationId,
  setOrganizationPlacementParentId,
}: CreateTeamOrganizationPlacementFieldsProps): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  return (
    <div className="space-y-3 border-b border-[var(--color-border)] pb-4">
      <div className="space-y-1">
        <p className="text-sm font-semibold">{t('create.organizationPlacement.title')}</p>
        <p className="text-xs text-[var(--color-text-muted)]">
          {t('create.organizationPlacement.description')}
        </p>
      </div>
      <div className="flex items-start gap-3">
        <Checkbox
          id="organization-placement-enabled"
          className="mt-1 shrink-0"
          checked={organizationPlacementEnabled}
          disabled={
            organizationStructureLoading ||
            (!organizationPlacementEnabled && organizationPlacementOrganizations.length === 0)
          }
          onCheckedChange={(checked) => setOrganizationPlacementEnabled(checked === true)}
        />
        <div className="min-w-0 space-y-1">
          <Label
            htmlFor="organization-placement-enabled"
            className="cursor-pointer text-sm font-semibold"
          >
            {t('create.organizationPlacement.addToOrganization')}
          </Label>
          {organizationPlacementError ? (
            <p className="text-[11px]" style={{ color: 'var(--field-error-text)' }}>
              {organizationPlacementError}
            </p>
          ) : null}
        </div>
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div className="space-y-1.5">
          <div className="space-y-0.5">
            <Label className="text-xs">{t('create.organizationPlacement.organizationLabel')}</Label>
            <p className="text-[11px] text-[var(--color-text-muted)]">
              {t('create.organizationPlacement.organizationHelp')}
            </p>
          </div>
          <Select
            value={activePlacementOrganization?.id ?? ''}
            disabled={
              !organizationPlacementEnabled || organizationPlacementOrganizations.length === 0
            }
            onValueChange={(value) => {
              setOrganizationPlacementOrganizationId(value);
              const organization = organizationPlacementOrganizations.find(
                (candidate) => candidate.id === value
              );
              setOrganizationPlacementParentId(organization?.rootNodeId ?? '');
            }}
          >
            <SelectTrigger className="h-8 text-xs">
              <SelectValue
                placeholder={t('create.organizationPlacement.organizationPlaceholder')}
              />
            </SelectTrigger>
            <SelectContent>
              {organizationPlacementOrganizations.map((organization) => (
                <SelectItem key={organization.id} value={organization.id}>
                  {organization.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <div className="space-y-0.5">
            <Label className="text-xs">{t('create.organizationPlacement.groupOrRootLabel')}</Label>
            <p className="text-[11px] text-[var(--color-text-muted)]">
              {t('create.organizationPlacement.groupOrRootHelp')}
            </p>
          </div>
          <Select
            value={activePlacementParent?.id ?? ''}
            disabled={
              !organizationPlacementEnabled || organizationPlacementParentOptions.length === 0
            }
            onValueChange={setOrganizationPlacementParentId}
          >
            <SelectTrigger className="h-8 text-xs">
              <SelectValue placeholder={t('create.organizationPlacement.groupOrRootPlaceholder')} />
            </SelectTrigger>
            <SelectContent>
              {organizationPlacementParentOptions.map((option) => (
                <SelectItem key={option.unit.id} value={option.unit.id}>
                  <span
                    className="flex min-w-0 items-center gap-2"
                    style={{ paddingLeft: `${Math.min(option.depth, 6) * 12}px` }}
                  >
                    <span className="truncate">{getOrganizationUnitLabel(option.unit)}</span>
                    <span className="shrink-0 text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">
                      {t(getOrganizationPlacementUnitKindKey(option.unit))}
                    </span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
    </div>
  );
};
