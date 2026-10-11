import { useId, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * A titled group of form fields: an h3 naming the group, then the fields
 * in a grid, one column on a phone and two from `md`. A `group` labelled by
 * its heading, so a screen reader entering a field hears which group it is
 * in; a group rather than a region, so a form of four groups does not add
 * four landmarks.
 */
export const FormGroup = ({
  title,
  children,
  className,
}: {
  title: string;
  children: ReactNode;
  className?: string;
}) => {
  const headingId = useId();
  return (
    <div
      role="group"
      aria-labelledby={headingId}
      className={cn('flex flex-col gap-4', className)}
    >
      <h3 id={headingId} className="text-base font-semibold">
        {title}
      </h3>
      <div className="grid gap-4 md:grid-cols-2">{children}</div>
    </div>
  );
};
