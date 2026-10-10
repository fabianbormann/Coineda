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

const renderSection = (user?: CarfUser) =>
  render(
    <CarfReconciliationSection
      reconciliation={reconcile({
        message: message(user ? [user] : []),
        ...(user ? { user } : {}),
        own,
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
});
