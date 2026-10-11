import type { Ref } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown } from 'lucide-react';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { DatevSettingsCard } from '@/datev/DatevSettingsCard';
import { validateDatevSettings } from '@/datev/buchungsstapel';
import { EndpointsSettingsCard } from '@/screens/EndpointsSettingsCard';
import {
  PUBLIC_ENDPOINTS,
  egressMode,
  isConfigured,
  resolveEndpoints,
  type Endpoints,
} from '@/config/endpoints';
import type { DatevSettings } from '@/settings/settingsStore';

/** "complete" only when the export would be enabled; "not set up" while
 *  nothing has been entered; "incomplete" for anything between. */
const datevStatus = (datev: DatevSettings | undefined): string => {
  if (validateDatevSettings(datev).length === 0) {
    return 'DATEV: complete';
  }
  const entered =
    datev !== undefined &&
    [
      datev.beraternummer,
      datev.mandantennummer,
      ...Object.values(datev.konten),
    ].some((field) => field.trim() !== '');
  return entered ? 'DATEV: incomplete' : 'DATEV: not set up';
};

/** "public" while every host is the public default in public mode. */
const endpointsStatus = (): string => {
  if (egressMode() === 'restricted') {
    return 'Endpoints: own (restricted)';
  }
  const endpoints = resolveEndpoints();
  const own = (Object.keys(PUBLIC_ENDPOINTS) as (keyof Endpoints)[]).some(
    (key) => isConfigured(endpoints, key),
  );
  return own ? 'Endpoints: own' : 'Endpoints: public';
};

type AdvancedSettingsSectionProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Germany: the DATEV card and its status. */
  showDatev: boolean;
  datev: DatevSettings | undefined;
  onDatevChange: (datev: DatevSettings) => void;
  datevHeadingRef?: Ref<HTMLHeadingElement>;
  className?: string;
};

/**
 * The settings a report can run without: the DATEV numbers and the data
 * endpoints. Closed by default so the form reads as what it is - nothing
 * on it is required - but the trigger states where each one stands, so a
 * hidden setting is never an invisible one.
 */
export const AdvancedSettingsSection = ({
  open,
  onOpenChange,
  showDatev,
  datev,
  onDatevChange,
  datevHeadingRef,
  className,
}: AdvancedSettingsSectionProps) => {
  const { t } = useTranslation();
  const status = [
    ...(showDatev ? [t(datevStatus(datev))] : []),
    t(endpointsStatus()),
  ].join(' · ');

  return (
    <Collapsible open={open} onOpenChange={onOpenChange} className={className}>
      <h3>
        <CollapsibleTrigger className="group flex w-full items-start justify-between gap-4 rounded-md text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
          <span className="flex flex-col gap-1">
            <span className="text-base font-semibold">
              {t('Advanced settings')}
            </span>
            <span className="text-sm font-normal text-muted-foreground">
              {status}
            </span>
          </span>
          <ChevronDown
            aria-hidden="true"
            className="mt-1 size-4 shrink-0 transition-transform group-data-[state=open]:rotate-180"
          />
        </CollapsibleTrigger>
      </h3>
      <CollapsibleContent className="mt-4 grid gap-4 md:grid-cols-2">
        {showDatev && (
          <DatevSettingsCard
            value={datev}
            onChange={onDatevChange}
            headingRef={datevHeadingRef}
          />
        )}
        <EndpointsSettingsCard />
      </CollapsibleContent>
    </Collapsible>
  );
};
