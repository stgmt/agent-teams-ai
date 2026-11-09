import { useAppTranslation } from '@features/localization/renderer';
import { getSpecificationTaskScope } from '@renderer/utils/specificationTaskPresentation';

import type { SpecificationTaskIdentity } from '@renderer/utils/specificationTaskPresentation';

interface SpecificationTaskDetailsProps {
  task: SpecificationTaskIdentity;
}

export function SpecificationTaskDetails({
  task,
}: SpecificationTaskDetailsProps): React.JSX.Element | null {
  const { t } = useAppTranslation('team');
  const scope = getSpecificationTaskScope(task);
  const registryLocalId = task.registryLocalId;
  const registryStatus = task.registryStatus;
  if (!scope || !registryLocalId || !registryStatus) return null;

  const registryEntity = task.registryEntity;
  return (
    <section
      aria-label={t('taskDetail.specification.ariaLabel')}
      data-testid="specification-task-details"
      className="mb-4 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 py-2.5"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="text-xs font-semibold text-[var(--color-text)]">
          {scope} · {registryLocalId}
        </h3>
        <p className="text-[11px] text-[var(--color-text-secondary)]">
          {t('taskDetail.specification.status', { status: registryStatus })}
        </p>
      </div>

      <div className="mt-2">
        <h4 className="text-[11px] font-semibold text-[var(--color-text-secondary)]">
          {t('taskDetail.specification.requirements')}
        </h4>
        {task.requirements ? (
          task.requirements.length > 0 ? (
            <ul className="mt-1 flex flex-wrap gap-1.5">
              {task.requirements.map((requirement) => (
                <li
                  key={requirement}
                  className="rounded border border-[var(--color-border)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-text)]"
                >
                  {requirement}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-[11px] text-[var(--color-text-muted)]">
              {t('taskDetail.specification.noRequirements')}
            </p>
          )
        ) : (
          <p className="mt-1 text-[11px] text-[var(--color-text-muted)]">
            {t('taskDetail.specification.requirementsUnavailable')}
          </p>
        )}
      </div>

      {registryEntity ? (
        <details className="mt-2 border-t border-[var(--color-border)] pt-2">
          <summary className="cursor-pointer text-[11px] text-[var(--color-text-secondary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">
            {t('taskDetail.specification.fullRecord')}
          </summary>
          <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-[var(--color-surface)] p-2 font-mono text-[10px] text-[var(--color-text-secondary)]">
            {JSON.stringify(registryEntity, null, 2)}
          </pre>
        </details>
      ) : null}
    </section>
  );
}
