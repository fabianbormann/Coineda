import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * The one place an anchor may open a new tab: it always severs the opener
 * and the referrer, and tells a screen reader the link leaves the page.
 */
export const ExternalLink = ({
  href,
  children,
  className,
}: {
  href: string;
  children: ReactNode;
  className?: string;
}) => {
  const { t } = useTranslation();
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={className}
    >
      {children}
      <span className="sr-only"> {t('(opens in a new tab)')}</span>
    </a>
  );
};
