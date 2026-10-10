import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { formatCrypto, formatFiat } from '@/components/money/format';
import { labelOfCode } from '@/carf/codes';
import type {
  CarfReconciliation,
  ReconciliationRow,
  Verdict,
} from '@/carf/reconcile';
import type { CarfCategory } from '@/carf/types';

/** Translation keys of the CARF categories, as the section names them. */
export const CATEGORY_LABELS: Record<CarfCategory, string> = {
  'fiat-in': 'Acquisitions against fiat',
  'fiat-out': 'Disposals against fiat',
  'crypto-in': 'Acquisitions against crypto',
  'crypto-out': 'Disposals against crypto',
  'transfer-in': 'Transfers in',
  'transfer-out': 'Transfers out',
  wallet: 'Transfers to own wallets',
  rrpt: 'Retail payments',
};

/** Translation keys of the verdicts. Text, never colour alone. */
export const VERDICT_LABELS: Record<Verdict | 'not-recognised', string> = {
  match: 'Matches',
  differs: 'Differs',
  'missing-own': 'Not in the ledger',
  'not-reported': 'Not reported',
  unpriced: 'Unpriced',
  'not-compared': 'Not compared',
  'not-recognised': 'Not recognised',
};

const VERDICT_CLASS: Record<Verdict, string> = {
  match: 'border-stroke',
  differs: 'border-destructive text-destructive',
  'missing-own': 'border-destructive text-destructive',
  'not-reported': 'border-destructive text-destructive',
  unpriced: 'border-stroke text-muted-foreground',
  'not-compared': 'border-stroke text-muted-foreground',
};

const TRANSFER_CATEGORIES = new Set<CarfCategory>([
  'transfer-in',
  'transfer-out',
]);

/** The first 12 hex characters, as the file name and the screen use. */
export const shortHash = (hash: string): string => hash.slice(0, 12);

export const reconciliationFilename = (r: CarfReconciliation): string =>
  `carf-reconciliation-${r.year}-${shortHash(r.fileHash)}.csv`;

/**
 * The printable "DAC8 / CARF reconciliation" section of the tax report:
 * the message header, the compared user and sources, a summary sentence,
 * the per-asset table and the names that could not be recognised.
 */
export const CarfReconciliationSection = ({
  reconciliation: r,
  onDownload,
}: {
  reconciliation: CarfReconciliation;
  onDownload: () => void;
}) => {
  const { t, i18n } = useTranslation();
  const language = i18n.language;
  const base = r.baseCurrency.toUpperCase();

  const units = (value: string, symbol: string) =>
    `${formatCrypto(value, language)} ${symbol}`;
  const money = (value: string, currency: string) =>
    currency === ''
      ? `${value} (${t('several currencies')})`
      : formatFiat(Number(value), language, currency.toUpperCase());
  const signed = (text: string, negative: boolean, zero: boolean) =>
    zero || negative ? text : `+${text}`;
  const count = (n: number) => t('{{count}} transactions', { count: n });

  const typeLine = (
    byType: Record<string, { transactions?: number; units: string }>,
    symbol: string,
  ) =>
    Object.entries(byType)
      .map(
        ([type, figures]) =>
          `${type ? t(labelOfCode(type)) : t('Untyped')}: ${
            figures.transactions !== undefined
              ? `${figures.transactions} × `
              : ''
          }${units(figures.units, symbol)}`,
      )
      .join(' · ');

  const reportedCell = (row: ReconciliationRow) => {
    const side = row.reported;
    if (!side) return <span className="text-muted-foreground">—</span>;
    return (
      <div className="flex flex-col">
        {side.transactions !== undefined && (
          <span>{count(side.transactions)}</span>
        )}
        <span>{units(side.units, row.symbol)}</span>
        <span>{money(side.amount, side.currency)}</span>
        {TRANSFER_CATEGORIES.has(row.category) &&
          Object.keys(side.byType).length > 1 && (
            <span className="text-xs text-muted-foreground">
              {typeLine(side.byType, row.symbol)}
            </span>
          )}
      </div>
    );
  };

  const ownCell = (row: ReconciliationRow) => {
    const side = row.own;
    if (!side) return <span className="text-muted-foreground">—</span>;
    return (
      <div className="flex flex-col">
        <span>{count(side.transactions)}</span>
        <span>{units(side.units, row.symbol)}</span>
        <span>
          {side.amount !== undefined ? money(side.amount, base) : t('No value')}
        </span>
        {side.fees !== '0' && (
          <span className="text-xs text-muted-foreground">
            {t('Fees')}: {units(side.fees, row.symbol)}
          </span>
        )}
        {side.fiatFees !== undefined && side.fiatFees !== '0' && (
          <span className="text-xs text-muted-foreground">
            {t('Fees')}: {money(side.fiatFees, base)}
          </span>
        )}
        {TRANSFER_CATEGORIES.has(row.category) &&
          Object.keys(side.byType).length > 1 && (
            <span className="text-xs text-muted-foreground">
              {typeLine(side.byType, row.symbol)}
            </span>
          )}
      </div>
    );
  };

  const deltaCell = (row: ReconciliationRow) => {
    const { transactions, units: du, amount } = row.delta;
    if (transactions === undefined && du === undefined && amount === undefined)
      return <span className="text-muted-foreground">—</span>;
    return (
      <div className="flex flex-col">
        {transactions !== undefined && (
          <span>
            {signed(String(transactions), transactions < 0, transactions === 0)}
          </span>
        )}
        {du !== undefined && (
          <span>
            {signed(units(du, row.symbol), du.startsWith('-'), du === '0')}
          </span>
        )}
        {amount !== undefined && (
          <span>
            {signed(
              money(amount, base),
              amount.startsWith('-'),
              amount === '0',
            )}
          </span>
        )}
      </div>
    );
  };

  const s = r.summary;

  return (
    <div data-testid="carf-reconciliation" className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold">
        {t('DAC8 / CARF reconciliation')}
      </h3>
      <Card>
        <CardContent className="flex flex-col gap-1 text-sm">
          <p>
            <span className="font-medium">{t('Provider')}: </span>
            {r.provider}
            {' · '}
            <span className="font-medium">MessageRefId: </span>
            <span className="break-all">{r.messageRefId}</span>
          </p>
          <p>
            <span className="font-medium">{t('Message type')}: </span>
            {t(labelOfCode(r.messageTypeIndic))} ({r.messageTypeIndic}){' · '}
            <span className="font-medium">{t('Reporting period')}: </span>
            {r.reportingPeriod}
            {' · '}
            <span className="font-medium">{t('Sent')}: </span>
            {r.timestamp}
          </p>
          <p>
            <span className="print:hidden">
              {t('File SHA-256: {{hash}}', { hash: shortHash(r.fileHash) })}
            </span>
            <span className="hidden break-all print:inline">
              {t('File SHA-256: {{hash}}', { hash: r.fileHash })}
            </span>
          </p>
          <p>
            <span className="font-medium">{t('User')}: </span>
            {r.user.name}
            {r.user.tins.length > 0 && (
              <>
                {' · '}
                <span className="font-medium">{t('TIN')}: </span>
                {r.user.tins
                  .map((tin) =>
                    tin.issuedBy ? `${tin.value} (${tin.issuedBy})` : tin.value,
                  )
                  .join(', ')}
              </>
            )}
            {' · '}
            <span className="font-medium">DocRefId: </span>
            {r.user.docRefId}
          </p>
          <p>
            <span className="font-medium">{t('Compared with')}: </span>
            {r.sourceLabels.join(' · ')}
          </p>
          <p className="font-medium">
            {t(
              '{{match}} match, {{differs}} differ, {{missing}} missing on one side, {{skipped}} not compared, {{unknown}} not recognised',
              {
                match: s.match,
                differs: s.differs,
                missing: s['missing-own'] + s['not-reported'],
                skipped: s['not-compared'] + s.unpriced,
                unknown: s['not-recognised'],
              },
            )}
          </p>

          {r.rows.length > 0 && (
            <div
              className="mt-2 overflow-x-auto"
              role="region"
              aria-label={t('DAC8 / CARF reconciliation')}
              tabIndex={0}
            >
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b">
                    <th scope="col" className="py-1 pr-3 font-medium">
                      {t('Asset')}
                    </th>
                    <th scope="col" className="py-1 pr-3 font-medium">
                      {t('Category')}
                    </th>
                    <th scope="col" className="py-1 pr-3 font-medium">
                      {t('Reported')}
                    </th>
                    <th scope="col" className="py-1 pr-3 font-medium">
                      {t('Own')}
                    </th>
                    <th scope="col" className="py-1 pr-3 font-medium">
                      {t('Difference')}
                    </th>
                    <th scope="col" className="py-1 font-medium">
                      {t('Verdict')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {r.rows.map((row) => (
                    <tr
                      key={`${row.assetId}|${row.category}`}
                      className="border-b align-top tabular-nums"
                    >
                      <td className="py-1 pr-3 font-medium">{row.symbol}</td>
                      <td className="py-1 pr-3">
                        {t(CATEGORY_LABELS[row.category])}
                        {row.note && (
                          <span className="block text-xs text-muted-foreground">
                            {t(row.note, row.noteParams)}
                          </span>
                        )}
                      </td>
                      <td className="py-1 pr-3">{reportedCell(row)}</td>
                      <td className="py-1 pr-3">{ownCell(row)}</td>
                      <td className="py-1 pr-3">{deltaCell(row)}</td>
                      <td className="py-1">
                        <span
                          className={`inline-block rounded-full border px-2 py-0.5 text-xs whitespace-nowrap ${VERDICT_CLASS[row.verdict]}`}
                        >
                          {t(VERDICT_LABELS[row.verdict])}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {r.unrecognised.length > 0 && (
            <div className="mt-2 flex flex-col gap-1">
              <p className="font-medium">{t('Reported, not recognised')}</p>
              <ul className="flex flex-col gap-1">
                {r.unrecognised.map((asset, index) => (
                  <li key={`${asset.name}-${index}`}>
                    <span className="font-medium">{asset.name}</span>
                    {' · '}
                    {asset.blocks
                      .map(
                        (block) =>
                          `${t(CATEGORY_LABELS[block.category])}: ${
                            block.transactions !== undefined
                              ? `${block.transactions} × `
                              : ''
                          }${formatCrypto(block.units, language)} · ${money(
                            block.amount,
                            block.currency,
                          )}`,
                      )
                      .join('; ')}
                  </li>
                ))}
              </ul>
              <p className="text-xs text-muted-foreground">
                {t(
                  'These names match no asset Coineda knows, or more than one; they are not guessed.',
                )}
              </p>
            </div>
          )}

          <p className="mt-2 text-xs text-muted-foreground">
            {t(
              'Only the figures above were read from the file; the file itself is not stored.',
            )}
          </p>
          <div className="print:hidden">
            <Button type="button" variant="outline" onClick={onDownload}>
              {t('Download reconciliation (CSV)')}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};
