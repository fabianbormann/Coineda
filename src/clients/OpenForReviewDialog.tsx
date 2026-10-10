import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { normalizeTransferSecret } from '@/checkpoint/format';
import { describeOpenError } from '@/checkpoint/errors';
import { useClient } from './ClientContext';
import { HandoverNotReviewableError, openForReview } from './review';

type Verdict = 'match' | 'mismatch' | 'none';

export const OpenForReviewDialog = ({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) => {
  const { t } = useTranslation();
  const { switchTo } = useClient();
  const [file, setFile] = useState<File | null>(null);
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [verdict, setVerdict] = useState<Verdict | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file || busy) return;
    setBusy(true);
    setError(null);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const record = await openForReview(
        bytes,
        normalizeTransferSecret(secret),
        file.name,
      );
      setVerdict(record.review?.verdict ?? 'none');
      await switchTo(record.id);
    } catch (err) {
      setError(
        err instanceof HandoverNotReviewableError
          ? t(
              'This is a handover checkpoint without the derived events; ask for a backup checkpoint to review the report.',
            )
          : describeOpenError(err, t),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{t('Open a checkpoint for review')}</DialogTitle>
            <DialogDescription>
              {file
                ? t('Review of {{file}} — read-only', { file: file.name })
                : t('read-only')}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="review-file">{t('Checkpoint file')}</Label>
            <Input
              id="review-file"
              type="file"
              accept=".coineda"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="review-secret">{t('Transfer secret')}</Label>
            <Input
              id="review-secret"
              value={secret}
              autoComplete="off"
              onChange={(e) => setSecret(e.target.value)}
            />
          </div>
          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
          {verdict && (
            <p className="text-sm" role="status">
              {verdict === 'match'
                ? t('Fingerprint matches the checkpoint.')
                : verdict === 'mismatch'
                  ? t('Fingerprint does NOT match the checkpoint.')
                  : t('The checkpoint stores no fingerprint.')}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              {t('Cancel')}
            </Button>
            <Button type="submit" disabled={!file || !secret.trim() || busy}>
              {t('Open')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};
