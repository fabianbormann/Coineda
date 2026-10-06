import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Upload } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * A drop target that is also a button.
 *
 * Both, deliberately. Dragging is the fastest route for someone who has the
 * download in a folder already, and it is also the one that cannot be
 * reached from a keyboard or a screen reader - so the same element is a
 * real <button> that opens the file picker, and the drop handling is added
 * on top. An area that only accepts a drag would be unusable for anyone not
 * using a mouse.
 *
 * `dragging` is tracked on a counter rather than a boolean because
 * dragenter and dragleave fire for every CHILD element the pointer crosses:
 * a boolean flips off the moment the cursor moves from the border onto the
 * label inside, so the highlight flickers.
 */
export const FileDropArea = ({
  onFile,
  accept = '.csv,text/csv,text/plain',
  disabled = false,
}: {
  onFile: (file: File) => void;
  accept?: string;
  disabled?: boolean;
}) => {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const [depth, setDepth] = useState(0);
  const dragging = depth > 0;

  const take = (file: File | undefined) => {
    if (file && !disabled) {
      onFile(file);
    }
  };

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => inputRef.current?.click()}
      onDragEnter={(dragged) => {
        dragged.preventDefault();
        setDepth((count) => count + 1);
      }}
      onDragLeave={() => setDepth((count) => Math.max(0, count - 1))}
      onDragOver={(dragged) => {
        // Without this the browser navigates to the file instead, replacing
        // the app with a view of the raw CSV.
        dragged.preventDefault();
      }}
      onDrop={(dropped) => {
        dropped.preventDefault();
        setDepth(0);
        take(dropped.dataTransfer.files?.[0]);
      }}
      className={cn(
        'flex w-full flex-col items-center gap-2 rounded-md border border-dashed px-4 py-8 text-sm transition-colors',
        'focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
        disabled && 'opacity-50',
        dragging
          ? 'border-foreground bg-accent'
          : 'border-stroke text-muted-foreground hover:border-foreground hover:text-foreground',
      )}
    >
      <Upload className="size-5" aria-hidden="true" />
      <span>{t('Drop the file here, or click to choose one')}</span>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(changed) => {
          const file = changed.target.files?.[0];
          // Cleared so choosing the SAME file again still fires a change
          // event; without it, re-exporting over the same filename does
          // nothing and says nothing.
          changed.target.value = '';
          take(file);
        }}
      />
    </button>
  );
};
