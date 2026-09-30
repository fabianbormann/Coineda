import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

export type ConfirmOptions = {
  title: string;
  /**
   * Required, not optional, and it must state the consequence. Account
   * deletion silently cascades to every transaction and transfer in that
   * account; today the user is told nothing beyond "are you sure?".
   * Making this mandatory forces each call site to say what is lost.
   */
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /**
   * Styles the confirm action with `Button`'s `destructive` variant
   * instead of the neutral default. Opt-in and defaulting to false so
   * existing/neutral confirmations are unaffected; this is the primitive
   * whose whole purpose is destructive actions, so call sites deleting
   * something should set it.
   */
  destructive?: boolean;
};

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

export const ConfirmProvider = ({
  children,
}: {
  children: React.ReactNode;
}) => {
  const { t } = useTranslation();
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  // The provider owns the pending resolver, not the caller, so an
  // unmounting caller cannot strand the promise.
  const resolverRef = useRef<((value: boolean) => void) | null>(null);

  const settle = useCallback((value: boolean) => {
    resolverRef.current?.(value);
    resolverRef.current = null;
    setOptions(null);
  }, []);

  const confirm = useCallback<ConfirmFn>((next) => {
    // A second confirm() while one is still pending supersedes it rather
    // than leaking it: settle the outstanding promise with false before
    // overwriting the resolver, so the first caller's `await confirm(...)`
    // is never stranded. This must resolve false, not true - a click that
    // never visibly confirmed anything must never read as "deleted".
    resolverRef.current?.(false);
    resolverRef.current = null;
    setOptions(next);
    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve;
    });
  }, []);

  // If the provider unmounts with a confirmation still open, decline it.
  // Otherwise the caller's `await confirm(...)` never settles and whatever
  // followed it - often the deletion itself - hangs forever.
  useEffect(
    () => () => {
      resolverRef.current?.(false);
      resolverRef.current = null;
    },
    [],
  );

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <AlertDialog
        open={options !== null}
        // Any dismissal - Escape, or the overlay where permitted - is a
        // decline. This must never default to true.
        onOpenChange={(open) => {
          if (!open) settle(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{options?.title}</AlertDialogTitle>
            <AlertDialogDescription>
              {options?.description}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => settle(false)}>
              {options?.cancelLabel ?? t('Cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              variant={options?.destructive ? 'destructive' : 'default'}
              onClick={() => settle(true)}
            >
              {options?.confirmLabel ?? t('Continue')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ConfirmContext.Provider>
  );
};

export const useConfirm = (): ConfirmFn => {
  const context = useContext(ConfirmContext);
  if (!context) {
    throw new Error('useConfirm must be used inside a ConfirmProvider');
  }
  return context;
};
