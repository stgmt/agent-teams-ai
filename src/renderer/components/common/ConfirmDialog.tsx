/**
 * ConfirmDialog - Reusable themed confirmation dialog.
 *
 * Replaces native window.confirm() with a styled modal that matches the app theme.
 * Controlled via useConfirmDialog() hook for imperative usage.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@renderer/components/ui/dialog';
import { AlertTriangle } from 'lucide-react';

interface ConfirmDialogState {
  isOpen: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'default' | 'danger';
  mode?: 'confirm' | 'info';
}

type ConfirmResolver = ((confirmed: boolean) => void) | null;

const initialState: ConfirmDialogState = {
  isOpen: false,
  title: '',
  message: '',
};

// Singleton state — one dialog at a time
let globalSetState: ((state: ConfirmDialogState) => void) | null = null;
let globalResolver: ConfirmResolver = null;

/**
 * Imperatively show a themed confirm dialog. Returns a promise that resolves
 * to true (confirmed) or false (cancelled).
 *
 * Usage:
 *   const confirmed = await confirm({ title: 'Delete?', message: 'This cannot be undone.' });
 */
// eslint-disable-next-line react-refresh/only-export-components -- imperative API shares singleton state with component
export async function confirm(opts: {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'default' | 'danger';
  mode?: 'confirm' | 'info';
}): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    // If a previous dialog is open, resolve it as cancelled
    if (globalResolver) {
      globalResolver(false);
    }

    globalResolver = resolve;
    globalSetState?.({
      isOpen: true,
      title: opts.title,
      message: opts.message,
      confirmLabel: opts.confirmLabel,
      cancelLabel: opts.cancelLabel,
      variant: opts.variant,
      mode: opts.mode,
    });
  });
}

/**
 * ConfirmDialog component. Mount once at the app root (e.g. in App.tsx).
 */
export const ConfirmDialog = (): React.JSX.Element | null => {
  const [state, setState] = useState<ConfirmDialogState>(initialState);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Register singleton setter
  useEffect(() => {
    globalSetState = setState;
    return () => {
      globalSetState = null;
    };
  }, []);

  const close = useCallback((confirmed: boolean) => {
    if (globalResolver) {
      globalResolver(confirmed);
      globalResolver = null;
    }
    setState(initialState);
  }, []);

  if (!state.isOpen) return null;

  const isDanger = state.variant === 'danger';

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close(false);
      }}
    >
      <DialogContent
        ref={dialogRef}
        className="max-w-sm border-[var(--color-border-emphasis)] bg-[var(--color-surface-overlay)]"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          dialogRef.current?.querySelector<HTMLButtonElement>('[data-confirm-btn]')?.focus();
        }}
      >
        {/* Icon + Title */}
        <div className="flex items-start gap-3">
          {isDanger && (
            <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-red-500/10">
              <AlertTriangle className="size-5 text-red-400" />
            </div>
          )}
          <div>
            <DialogTitle className="text-sm font-semibold">{state.title}</DialogTitle>
            <DialogDescription className="mt-1 text-sm text-[var(--color-text-secondary)]">
              {state.message}
            </DialogDescription>
          </div>
        </div>

        {/* Actions */}
        <div className="mt-5 flex justify-end gap-3">
          {state.mode !== 'info' && (
            <button
              onClick={() => close(false)}
              className="rounded-md border px-4 py-2 text-sm font-medium transition-colors hover:bg-white/5"
              style={{
                borderColor: 'var(--color-border)',
                color: 'var(--color-text-secondary)',
              }}
            >
              {state.cancelLabel ?? 'Cancel'}
            </button>
          )}
          <button
            data-confirm-btn
            onClick={() => close(true)}
            className={`rounded-md px-4 py-2 text-sm font-medium transition-colors ${
              isDanger
                ? 'bg-red-600 text-white hover:bg-red-500'
                : 'bg-zinc-600 text-white hover:bg-zinc-500'
            }`}
          >
            {state.confirmLabel ?? 'Confirm'}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
};
