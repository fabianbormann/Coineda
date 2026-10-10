import type { ComponentPropsWithoutRef } from 'react';
import { useTranslation } from 'react-i18next';

type Props = Omit<ComponentPropsWithoutRef<'a'>, 'target' | 'rel' | 'href'> & {
  href: string;
};

/**
 * The one place an anchor may open a new tab: it always severs the opener
 * and the referrer, and tells a screen reader the link leaves the page.
 */
export const ExternalLink = ({ href, children, ...rest }: Props) => {
  const { t } = useTranslation();
  return (
    <a {...rest} href={href} target="_blank" rel="noopener noreferrer">
      {children}
      <span className="sr-only"> {t('(opens in a new tab)')}</span>
    </a>
  );
};
