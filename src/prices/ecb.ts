import Big from 'big.js';

/**
 * Euro-area reference rates, for turning DefiLlama's USD quotes into the
 * base currency.
 *
 * Served by Frankfurter (https://frankfurter.dev), which republishes the
 * European Central Bank's own daily reference rates. Measured live on
 * 2026-10-05: keyless, `access-control-allow-origin: *`, 30 currencies, and
 * a whole date range in ONE request.
 *
 * The provenance is the reason this is not just a convenience. A tax report
 * has to say where a figure came from, and "the ECB's published reference
 * rate for that day" is a citable, auditable source in a way that a price
 * provider's own undocumented EUR quote is not. Whether a particular tax
 * office requires a specific source is a question for the person filing -
 * Coineda gives no advice - but an auditable default is the better one.
 */
const ROOT = 'https://api.frankfurter.dev/v1';

const TIMEOUT_MS = 15_000;

const DAY_MS = 86_400_000;

/**
 * How far back a rate may be carried to cover a day that has none.
 *
 * The ECB publishes on business days only, so a Saturday disposal has no
 * rate of its own and takes Friday's - which is what Frankfurter itself
 * does when asked for a single weekend date, and it says so by answering
 * with the earlier date. Four days covers a weekend plus the longest run of
 * public holidays the ECB observes. Past that the carry STOPS rather than
 * reaching further: a rate from the far side of a long gap is a guess, and
 * a missing price is a better answer than a quietly stale one.
 */
export const MAX_CARRY_DAYS = 4;

export class EcbRateError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`the ECB rate service answered with status ${status}`);
    this.name = 'EcbRateError';
    this.status = status;
  }
}

const isoDay = (at: number): string => new Date(at).toISOString().slice(0, 10);

/**
 * How many units of `currency` one US dollar bought, per requested day.
 *
 * Fetched as one range covering every day asked for - the span between the
 * earliest and latest, which for a tax year is a single request whatever
 * the number of disposals.
 *
 * A day the ECB did not publish takes the most recent earlier rate, up to
 * MAX_CARRY_DAYS, and is simply absent beyond that. The caller reports it,
 * rather than this inventing one.
 *
 * Returns rates of exactly 1 for 'usd' without asking anybody: the quotes
 * being converted are already in dollars.
 */
export const fetchUsdRates = async (
  isoDates: string[],
  currency: string,
  signal?: AbortSignal,
): Promise<Map<string, string>> => {
  const rates = new Map<string, string>();
  const days = [...new Set(isoDates)].sort();
  if (days.length === 0) {
    return rates;
  }

  const symbol = currency.toUpperCase();
  if (symbol === 'USD') {
    for (const day of days) {
      rates.set(day, '1');
    }
    return rates;
  }

  // The range starts before the earliest day asked for, so a Monday at the
  // very start of the span can still carry back to the Friday before it.
  const from = isoDay(
    Date.parse(`${days[0]}T00:00:00Z`) - MAX_CARRY_DAYS * DAY_MS,
  );
  const to = days[days.length - 1];

  const response = await fetch(
    `${ROOT}/${from}..${to}?base=USD&symbols=${encodeURIComponent(symbol)}`,
    {
      headers: { Accept: 'application/json' },
      signal: signal ?? AbortSignal.timeout(TIMEOUT_MS),
    },
  );
  if (!response.ok) {
    throw new EcbRateError(response.status);
  }

  const body = (await response.json()) as {
    rates?: Record<string, Record<string, unknown>>;
  };

  const published = new Map<string, string>();
  for (const [day, quoted] of Object.entries(body.rates ?? {})) {
    const value = quoted?.[symbol];
    if (typeof value === 'number' && Number.isFinite(value)) {
      published.set(day, new Big(String(value)).toString());
    }
  }

  for (const day of days) {
    const asked = Date.parse(`${day}T00:00:00Z`);
    for (let back = 0; back <= MAX_CARRY_DAYS; back += 1) {
      const candidate = published.get(isoDay(asked - back * DAY_MS));
      if (candidate !== undefined) {
        rates.set(day, candidate);
        break;
      }
    }
  }

  return rates;
};
