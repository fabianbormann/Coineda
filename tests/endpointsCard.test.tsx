import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import 'fake-indexeddb/auto';
import '@/i18n';
import { EndpointsSettingsCard } from '@/screens/EndpointsSettingsCard';
import { ClientProvider } from '@/clients/ClientContext';
import type { ClientRecord } from '@/clients/registry';
import { ENDPOINTS_KEY } from '@/config/deviceConfig';

beforeEach(() => {
  localStorage.removeItem(ENDPOINTS_KEY);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const ready = (label: RegExp) => screen.findByLabelText(label);

describe('the endpoints settings card', () => {
  it('lists each endpoint with Default for the unset ones', async () => {
    render(<EndpointsSettingsCard />);
    await ready(/^exchange rates/i);
    for (const label of [
      /^price history/i,
      /^spot prices/i,
      /^exchange rates/i,
      /^token registry/i,
      /^bitcoin indexer/i,
      /^ethereum indexer/i,
      /^cardano \(yaci\)/i,
      /^cardano \(blockfrost\)/i,
    ]) {
      expect(screen.getByLabelText(label)).toBeInTheDocument();
    }
    expect(screen.getAllByText('Default')).toHaveLength(8);
    expect(screen.queryByLabelText(/bitpanda/i)).toBeNull();
  });

  it('rejects a non-https URL and does not store it', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    render(<EndpointsSettingsCard />);
    const fx = await ready(/^exchange rates/i);
    await userEvent.type(fx, 'http://x');
    await userEvent.tab();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Must be an https URL',
    );
    expect(setItem.mock.calls.map(([key]) => key)).not.toContain(ENDPOINTS_KEY);
  });

  it('persists a valid override on blur', async () => {
    render(<EndpointsSettingsCard />);
    const fx = await ready(/^exchange rates/i);
    await userEvent.type(fx, 'https://fx.example.gov');
    await userEvent.tab();
    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem(ENDPOINTS_KEY) ?? '{}')).toEqual({
        fx: 'https://fx.example.gov',
      }),
    );
  });

  it('is disabled for a review client and writes nothing', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const review: ClientRecord = {
      id: 'c-1',
      label: 'Müller GmbH',
      dbName: 'db-1',
      kind: 'review',
      createdAt: '2026-01-01T00:00:00.000Z',
      review: {
        fingerprint: 'abcdef0123456789abcdef',
        omittedEventCount: 0,
        file: 'mueller.coineda',
        verdict: 'match',
      },
    };
    render(
      <ClientProvider client={review} onChange={vi.fn()}>
        <EndpointsSettingsCard />
      </ClientProvider>,
    );
    expect(await screen.findByLabelText(/^exchange rates/i)).toBeDisabled();
    expect(setItem.mock.calls.map(([key]) => key)).not.toContain(ENDPOINTS_KEY);
  });

  it('is read-only with a sentence when the build pins restricted', async () => {
    vi.stubEnv('VITE_EGRESS', 'restricted');
    render(<EndpointsSettingsCard />);
    expect(
      await screen.findByText(
        'This build fixes the endpoints; they cannot be changed here.',
      ),
    ).toBeInTheDocument();
    for (const box of screen.getAllByRole('textbox')) {
      expect(box).toHaveAttribute('readonly');
    }
  });
});

describe('the build-fixed endpoints', () => {
  it('shows the build value read-only for a field VITE_ENDPOINTS fixes', async () => {
    vi.stubEnv(
      'VITE_ENDPOINTS',
      JSON.stringify({ fx: 'https://fx.operator.example' }),
    );
    render(<EndpointsSettingsCard />);
    await ready(/^price history/i);
    const fx = screen.getByLabelText(/^exchange rates/i);
    expect(fx).toHaveValue('https://fx.operator.example');
    expect(fx).toHaveAttribute('readonly');
    expect(screen.getByLabelText(/^spot prices/i)).not.toHaveAttribute(
      'readonly',
    );
  });
});
