import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

/** One step of the trail: a route to link to, an action, or neither (the
 *  current step, which is always the last). */
export type Crumb = {
  label: string;
  to?: string;
  onSelect?: () => void;
};

const STEP_CLASS =
  'rounded-sm underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50';

/**
 * Where the user is and how they got there, at the top of a screen: every
 * earlier step a link or a button, the current one plain text with
 * `aria-current="page"`. Steps not yet reached are simply not in `items`.
 * Off paper - a printed sheet has nowhere to navigate to.
 */
export const Breadcrumbs = ({
  items,
  className,
}: {
  items: Crumb[];
  className?: string;
}) => {
  const { t } = useTranslation();
  return (
    <nav aria-label={t('Breadcrumb')} className={cn('print:hidden', className)}>
      <ol className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
        {items.map((item, index) => {
          const current = index === items.length - 1;
          return (
            <li key={item.label} className="inline-flex items-center gap-1.5">
              {index > 0 && (
                <ChevronRight className="size-3.5" aria-hidden="true" />
              )}
              {current ? (
                <span aria-current="page" className="text-foreground">
                  {item.label}
                </span>
              ) : item.to !== undefined ? (
                <Link to={item.to} className={STEP_CLASS}>
                  {item.label}
                </Link>
              ) : (
                <button
                  type="button"
                  onClick={item.onSelect}
                  className={STEP_CLASS}
                >
                  {item.label}
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
};
