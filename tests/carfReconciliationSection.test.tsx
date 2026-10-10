import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import i18n from '@/i18n';
import { reconcile } from '@/carf/reconcile';
import type { OwnFigures } from '@/carf/aggregate';
import type { CarfAssetReport, CarfMessage, CarfUser } from '@/carf/types';
import { CarfReconciliationSection } from '@/screens/CarfReconciliationSection';

const BTC = 'bitcoin:native';

const message = (users: CarfUser[]): CarfMessage => ({
  messageRefId: 'M1',
  messageTypeIndic: users.length === 0 ? 'CARF703' : 'CARF701',
  reportingPeriod: '2026-12-31',
  year: 2026,
  timestamp: '2027-03-15T10:20:30',
  transmittingCountry: 'DE',
  receivingCountry: 'DE',
  provider: { name: 'Bitpanda GmbH', docRefId: 'P1' },
  users,
});

const erika = (assets: CarfAssetReport[]): CarfUser => ({
  name: 'Erika Mustermann',
  tins: [{ value: '12 345 678 901', issuedBy: 'DE' }],
  docRefId: 'D1',
  docTypeIndic: 'OECD1',
  assets,
});

const own: OwnFigures = {
  [BTC]: {
    'fiat-in': {
      transactions: 1,
      units: '25000000',
      amount: '15000',
      fees: '0',
      fiatFees: '0',
      byType: {},
    },
  },
};

const renderSection = (user?: CarfUser, figures: OwnFigures = own) =>
  render(
    <CarfReconciliationSection
      reconciliation={reconcile({
        message: message(user ? [user] : []),
        ...(user ? { user } : {}),
        own: figures,
        baseCurrency: 'eur',
        fileHash: 'a'.repeat(64),
        sources: [{ id: 's1', label: 'Bitpanda' }],
      })}
      onDownload={() => {}}
    />,
  );

beforeEach(async () => {
  await i18n.changeLanguage('en');
});

describe('CarfReconciliationSection', () => {
  it('says no user was reported for a message without users', () => {
    renderSection();
    const section = screen.getByTestId('carf-reconciliation');
    expect(section.textContent).toContain('User: No user reported');
    expect(section.textContent).not.toContain('DocRefId: D1');
    expect(section.textContent).toContain('Not reported');
  });

  it('shows the user, TINs and DocRefId when there is one', () => {
    renderSection(erika([]));
    const section = screen.getByTestId('carf-reconciliation');
    expect(section.textContent).toContain('Erika Mustermann');
    expect(section.textContent).toContain('12 345 678 901 (DE)');
    expect(section.textContent).toContain('DocRefId: D1');
  });

  const fiatIn = (amount: string, units = '0.250000') => ({
    category: 'fiat-in' as const,
    transactions: 1,
    amount,
    currency: 'EUR',
    units,
  });

  it('states the limits of the comparison under the table', () => {
    renderSection(erika([]));
    const section = screen.getByTestId('carf-reconciliation');
    expect(section.textContent).toContain(
      'Amounts match within 1 % or 1.00 EUR. The provider values at transaction time, Coineda at the UTC-day price. Retail payments (RRPT) are not computed. Transfer types are shown for orientation only. Fees are kept out of the amounts and listed separately. Deposits and withdrawals are usually unpriced.',
    );
  });

  it('counts unpriced rows apart from the rows not compared', () => {
    renderSection(
      erika([
        {
          name: 'BTC',
          blocks: [
            fiatIn('15000.00'),
            { ...fiatIn('1.00'), category: 'rrpt' as const },
          ],
        },
      ]),
      {
        [BTC]: {
          'fiat-in': {
            transactions: 1,
            units: '25000000',
            fees: '0',
            byType: {},
          },
        },
      },
    );
    const section = screen.getByTestId('carf-reconciliation');
    expect(section.textContent).toContain(
      '0 match, 0 differ, 0 missing on one side, 1 unpriced, 1 not compared, 0 not recognised',
    );
  });

  it('lists fiat the provider reported as a crypto-asset apart from unrecognised names', () => {
    renderSection(
      erika([
        { name: 'EUR', blocks: [fiatIn('100.00', '100')] },
        { name: 'XYZNOPE', blocks: [fiatIn('5.00', '1')] },
      ]),
    );
    const section = screen.getByTestId('carf-reconciliation');
    expect(section.textContent).toContain(
      'Listed by the provider but not a crypto-asset',
    );
    expect(section.textContent).toContain('Reported, not recognised');
    const fiatList = screen
      .getByText('Listed by the provider but not a crypto-asset')
      .closest('div');
    expect(fiatList?.textContent).toContain('EUR');
    expect(fiatList?.textContent).not.toContain('XYZNOPE');
  });

  it('formats a large amount from its decimal string without losing digits', () => {
    renderSection(
      erika([{ name: 'BTC', blocks: [fiatIn('12345678901234567.25')] }]),
    );
    const section = screen.getByTestId('carf-reconciliation');
    expect(section.textContent).toContain('12,345,678,901,234,567.25');
  });

  it('keeps TIN as TIN in German', async () => {
    await i18n.changeLanguage('de');
    renderSection(erika([]));
    const section = screen.getByTestId('carf-reconciliation');
    expect(section.textContent).toContain('TIN: 12 345 678 901 (DE)');
    expect(section.textContent).not.toContain('Steuer-ID');
  });
});
