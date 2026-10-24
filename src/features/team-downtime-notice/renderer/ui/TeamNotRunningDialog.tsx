import { useRef } from 'react';

import { useAppTranslation, useLocaleFormatters } from '@features/localization/renderer';
import { Button } from '@renderer/components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@renderer/components/ui/collapsible';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog';
import { ChevronRight, Play, Power } from 'lucide-react';

import { buildNotRunningDialogModel } from '../view-models/notRunningDialogModel';

import type { DowntimeEpisode } from '../../core/domain/downtimeEpisode';

export interface TeamNotRunningDialogProps {
  open: boolean;
  teamName: string;
  episode: DowntimeEpisode | null;
  /** Owner messages still waiting for delivery. */
  queuedCount: number;
  onClose: () => void;
  onLaunch: () => void;
}

export function TeamNotRunningDialog({
  open,
  teamName,
  episode,
  queuedCount,
  onClose,
  onLaunch,
}: Readonly<TeamNotRunningDialogProps>): React.JSX.Element | null {
  const { t } = useAppTranslation('team');
  const formatters = useLocaleFormatters();
  const launchButtonRef = useRef<HTMLButtonElement>(null);

  if (!episode) return null;
  const model = buildNotRunningDialogModel(episode, queuedCount, (iso) => formatters.time(iso));

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        className="max-w-md border-amber-500/30"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          launchButtonRef.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2.5 text-base">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-amber-500/20 bg-amber-500/10 text-amber-600 dark:text-amber-300">
              <Power size={14} />
            </span>
            {t('detail.notRunning.title', { name: teamName })}
          </DialogTitle>
          <DialogDescription>{t(model.reason.key, model.reason.values)}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2 text-sm text-[var(--color-text-secondary)]">
          <p>{t('detail.notRunning.consequence')}</p>
          {model.saved && <p>{t(model.saved.key, model.saved.values)}</p>}
          {model.queued && <p>{t(model.queued.key, model.queued.values)}</p>}
        </div>
        {model.details && (
          <Collapsible>
            <CollapsibleTrigger className="group flex items-center gap-1 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
              <ChevronRight
                size={12}
                className="transition-transform group-data-[state=open]:rotate-90"
              />
              {t('detail.notRunning.details')}
            </CollapsibleTrigger>
            <CollapsibleContent>
              <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-2 text-xs text-[var(--color-text-secondary)]">
                {model.details}
              </pre>
            </CollapsibleContent>
          </Collapsible>
        )}
        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={onClose}>
            {t('detail.notRunning.close')}
          </Button>
          <Button ref={launchButtonRef} onClick={onLaunch}>
            <Play size={14} />
            {t('detail.notRunning.launch')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
