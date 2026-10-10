import { useContext, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { ClientContext } from './ClientContext';
import { OpenForReviewDialog } from './OpenForReviewDialog';
import {
  createClient,
  labelOf as translatedLabel,
  listClients,
  removeClient,
  renameClient,
  type ClientRecord,
} from './registry';

type Mode = 'new' | 'rename' | 'delete' | null;

export const ClientMenu = () => {
  const ctx = useContext(ClientContext);
  const { t } = useTranslation();
  const [mode, setMode] = useState<Mode>(null);
  const [text, setText] = useState('');
  const [reviewOpen, setReviewOpen] = useState(false);

  // The shell is also rendered without a provider in isolation tests.
  if (!ctx) return null;
  const { client, refresh, switchTo } = ctx;

  // The seeded default label is a translation key; anything a user typed is
  // shown verbatim.
  const labelOf = (c: ClientRecord) => translatedLabel(c, t);

  const clients = listClients();
  const isLast =
    client.kind === 'client' &&
    clients.filter((c) => c.kind === 'client').length <= 1;

  const open = (m: Exclude<Mode, null>) => {
    setText(m === 'rename' ? labelOf(client) : '');
    setMode(m);
  };
  const close = () => setMode(null);

  const closeReview = async () => {
    await removeClient(client.id);
    const next = listClients().find((c) => c.kind === 'client');
    if (next) await switchTo(next.id);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const value = text.trim();
    if (mode === 'new' && value) {
      const created = createClient(value);
      close();
      await switchTo(created.id);
    } else if (mode === 'rename' && value) {
      renameClient(client.id, value);
      close();
      refresh();
    } else if (mode === 'delete' && text === labelOf(client) && !isLast) {
      await removeClient(client.id);
      close();
      const next = listClients().find((c) => c.kind === 'client');
      if (next) await switchTo(next.id);
    }
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            aria-label={`${t('Clients')}: ${labelOf(client)}`}
          >
            <span className="max-w-40 truncate">{labelOf(client)}</span>
            <ChevronDown aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel>{t('Clients')}</DropdownMenuLabel>
          {clients.map((c) => (
            <DropdownMenuItem
              key={c.id}
              aria-current={c.id === client.id ? 'true' : undefined}
              onSelect={() => {
                if (c.id !== client.id) void switchTo(c.id);
              }}
            >
              <span className="w-4" aria-hidden="true">
                {c.id === client.id ? '✓' : ''}
              </span>
              <span className="truncate">{labelOf(c)}</span>
              {c.kind === 'review' && (
                <span className="ml-auto rounded bg-muted px-1.5 text-xs text-muted-foreground">
                  {t('read-only')}
                </span>
              )}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => open('new')}>
            {t('New client')}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => open('rename')}>
            {t('Rename')}
          </DropdownMenuItem>
          <DropdownMenuItem
            // aria-disabled rather than disabled: a disabled Radix item is
            // skipped by arrow keys, so its explanation would never be heard.
            aria-disabled={isLast ? 'true' : undefined}
            aria-describedby={isLast ? 'client-last-note' : undefined}
            className={isLast ? 'opacity-50' : undefined}
            onSelect={(event) => {
              if (isLast) {
                event.preventDefault();
                return;
              }
              open('delete');
            }}
          >
            {t('Delete client')}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setReviewOpen(true)}>
            {t('Open a checkpoint for review')}
          </DropdownMenuItem>
          {client.kind === 'review' && (
            <>
              <DropdownMenuLabel className="font-normal text-muted-foreground">
                {t('Review of {{file}} — read-only', {
                  file: client.review?.file ?? labelOf(client),
                })}
              </DropdownMenuLabel>
              <DropdownMenuItem onSelect={() => void closeReview()}>
                {t('Close review')}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {isLast && (
        <span id="client-last-note" className="sr-only">
          {t('The last client cannot be deleted')}
        </span>
      )}

      <OpenForReviewDialog open={reviewOpen} onOpenChange={setReviewOpen} />

      <Dialog open={mode !== null} onOpenChange={(o) => !o && close()}>
        <DialogContent>
          <form onSubmit={submit} className="grid gap-4">
            <DialogHeader>
              <DialogTitle>
                {mode === 'new' && t('New client')}
                {mode === 'rename' && t('Rename')}
                {mode === 'delete' && t('Delete client')}
              </DialogTitle>
              <DialogDescription>
                {mode === 'delete'
                  ? t(
                      'This permanently deletes {{label}} and all its data from this device. Type the label to confirm',
                      { label: labelOf(client) },
                    )
                  : t('Label')}
              </DialogDescription>
            </DialogHeader>
            <Input
              autoFocus
              aria-label={
                mode === 'delete' ? t('Type the label to confirm') : t('Label')
              }
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={close}>
                {t('Cancel')}
              </Button>
              {mode === 'delete' ? (
                <Button
                  type="submit"
                  variant="destructive"
                  disabled={text !== labelOf(client)}
                >
                  {t('Delete')}
                </Button>
              ) : (
                <Button type="submit" disabled={!text.trim()}>
                  {mode === 'new' ? t('Create') : t('Save')}
                </Button>
              )}
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
};
