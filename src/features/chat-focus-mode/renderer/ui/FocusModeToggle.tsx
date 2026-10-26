import { type JSX, useEffect, useRef } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { Button } from '@renderer/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { cn } from '@renderer/lib/utils';
import { Clock, Focus } from 'lucide-react';

interface FocusModeToggleProps {
  active: boolean;
  pendingCount: number;
  onToggle: () => void;
  onJumpToPending: () => void;
}

function isShown(element: HTMLElement | null): boolean {
  return Boolean(element?.isConnected && element.getClientRects().length > 0);
}

export const FocusModeToggle = ({
  active,
  pendingCount,
  onToggle,
  onJumpToPending,
}: FocusModeToggleProps): JSX.Element => {
  const { t } = useAppTranslation('team');
  const buttonRef = useRef<HTMLButtonElement>(null);
  const onToggleRef = useRef(onToggle);
  onToggleRef.current = onToggle;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event.code !== 'KeyF' || !isShown(buttonRef.current)) return;
      event.preventDefault();
      onToggleRef.current();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <div
      className="flex shrink-0 items-center gap-1"
      onPointerDown={(event) => event.stopPropagation()}
    >
      {active && pendingCount > 0 ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={t('messages.focus.pending', { count: pendingCount })}
              className="flex shrink-0 items-center gap-0.5 whitespace-nowrap rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium leading-none text-amber-400 hover:bg-amber-500/25"
              onClick={onJumpToPending}
            >
              <Clock size={10} aria-hidden="true" />
              {pendingCount}
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {t('messages.focus.pending', { count: pendingCount })}
          </TooltipContent>
        </Tooltip>
      ) : null}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            ref={buttonRef}
            type="button"
            variant="ghost"
            size="sm"
            aria-pressed={active}
            aria-label={t('messages.focus.toggle')}
            className={cn(
              'size-7 p-0 text-[var(--color-text-muted)] hover:text-[var(--color-text)]',
              active && 'bg-[var(--color-surface-raised)] text-blue-400 hover:text-blue-300'
            )}
            onClick={onToggle}
          >
            <Focus size={14} />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{t('messages.focus.toggleHint')}</TooltipContent>
      </Tooltip>
    </div>
  );
};
