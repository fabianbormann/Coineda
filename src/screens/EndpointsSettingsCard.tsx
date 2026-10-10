import { useContext, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ClientContext } from '@/clients/ClientContext';
import {
  PUBLIC_ENDPOINTS,
  buildPinsRestricted,
  defaultEndpoints,
  resolveEndpoints,
  type Endpoints,
} from '@/config/endpoints';
import {
  readDeviceEndpoints,
  writeDeviceEndpoints,
} from '@/config/deviceConfig';

/** Bitpanda is not listed: it is a hosted exchange API, not self-hostable. */
const FIELDS: { key: Exclude<keyof Endpoints, 'bitpanda'>; label: string }[] = [
  { key: 'priceHistory', label: 'Price history' },
  { key: 'spotPrices', label: 'Spot prices' },
  { key: 'fx', label: 'Exchange rates' },
  { key: 'tokenRegistry', label: 'Token registry' },
  { key: 'bitcoinEsplora', label: 'Bitcoin indexer' },
  { key: 'ethereumBlockscout', label: 'Ethereum indexer' },
  { key: 'cardanoYaci', label: 'Cardano (Yaci)' },
  { key: 'cardanoBlockfrost', label: 'Cardano (Blockfrost)' },
];

/** https only: a plain-http endpoint would send addresses in the clear. */
const isHttps = (value: string): boolean => {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
};

/**
 * Per-device overrides of the outbound data hosts (they apply to every
 * client). An empty field keeps the default. Written on blur to the device
 * config. Disabled in review mode; read-only when the build pins
 * `VITE_EGRESS=restricted`, and per field when the build fixes that host in
 * `VITE_ENDPOINTS` - an operator's guarantee is not the user's to change.
 * The value shown is the one in force (build > device > public default).
 */
export const EndpointsSettingsCard = () => {
  const { t } = useTranslation();
  const readOnly = useContext(ClientContext)?.readOnly ?? false;
  const pinned = buildPinsRestricted();
  const [values, setValues] = useState<Partial<Endpoints>>(() =>
    readDeviceEndpoints(),
  );
  const [invalid, setInvalid] = useState<Set<string>>(new Set());

  const buildDefaults = defaultEndpoints();
  const validOverrides: Partial<Endpoints> = {};
  for (const [key, value] of Object.entries(values)) {
    if (isHttps(value.trim())) {
      validOverrides[key as keyof Endpoints] = value.trim();
    }
  }
  const inForce = resolveEndpoints(validOverrides);

  const leave = (key: keyof Endpoints) => {
    if (readOnly || pinned) {
      return;
    }
    const raw = (values[key] ?? '').trim();
    if (raw !== '' && !isHttps(raw)) {
      setInvalid((previous) => new Set(previous).add(key));
      return;
    }
    setInvalid((previous) => {
      const next = new Set(previous);
      next.delete(key);
      return next;
    });
    // Persist only the valid overrides: an invalid sibling stays on screen
    // but is never stored.
    const next: Partial<Endpoints> = {};
    for (const field of FIELDS) {
      const value = (values[field.key] ?? '').trim();
      if (value !== '' && isHttps(value)) {
        next[field.key] = value;
      }
    }
    writeDeviceEndpoints(next);
  };

  return (
    <Card>
      <CardContent className="flex flex-col gap-4 text-sm">
        <h3 className="font-semibold">{t('Data endpoints')}</h3>
        {pinned && (
          <p className="text-muted-foreground">
            {t('This build fixes the endpoints; they cannot be changed here.')}
          </p>
        )}
        <p className="text-muted-foreground">
          {t('These endpoints apply to every client on this device.')}
        </p>
        {FIELDS.map(({ key, label }) => {
          const override = (values[key] ?? '').trim();
          const effective = inForce[key];
          // The build fixes this host (VITE_ENDPOINTS): not editable here.
          const fixedByBuild = buildDefaults[key] !== PUBLIC_ENDPOINTS[key];
          return (
            <div key={key} className="flex flex-col gap-2">
              <Label htmlFor={`endpoint-${key}`}>{t(label)}</Label>
              {pinned || fixedByBuild ? (
                <Input
                  id={`endpoint-${key}`}
                  className="font-mono"
                  value={effective}
                  readOnly
                />
              ) : (
                <>
                  <Input
                    id={`endpoint-${key}`}
                    inputMode="url"
                    autoComplete="off"
                    placeholder={PUBLIC_ENDPOINTS[key]}
                    value={values[key] ?? ''}
                    onChange={(event) =>
                      setValues((previous) => ({
                        ...previous,
                        [key]: event.target.value,
                      }))
                    }
                    onBlur={() => leave(key)}
                    disabled={readOnly}
                    aria-invalid={invalid.has(key) || undefined}
                  />
                  <p className="text-muted-foreground">
                    {override === '' ? t('Default') : effective}
                  </p>
                  {invalid.has(key) && (
                    <p className="text-destructive" role="alert">
                      {t('Must be an https URL')}
                    </p>
                  )}
                </>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
};
