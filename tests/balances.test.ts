import { describe, it, expect } from 'vitest';
import type { LedgerEvent, Leg } from '@/ledger/types';
import {
  foldDisposals,
  foldHoldings,
  isInternalTransfer,
} from '@/ledger/balances';

const leg = (over: Partial<Leg>): Leg => ({
  assetId: 'cardano:lovelace',
  amount: '0',
  direction: 'in',
  venue: 'wallet-1',
  role: 'principal',
  ...over,
});

const event = (over: Partial<LedgerEvent>): LedgerEvent => ({
  id: crypto.randomUUID(),
  sourceId: 'src-a',
  externalId: crypto.randomUUID(),
  timestamp: 1_700_000_000_000,
  kind: 'reward',
  origin: 'derived',
  legs: [],
  ...over,
});

const owned = new Set(['wallet-1', 'wallet-2']);

describe('folding holdings', () => {
  it('adds in-legs and subtracts out-legs per asset', () => {
    const holdings = foldHoldings(
      [
        event({ legs: [leg({ amount: '10', direction: 'in' })] }),
        event({ legs: [leg({ amount: '4', direction: 'out' })] }),
      ],
      owned,
    );
    expect(holdings).toEqual([{ assetId: 'cardano:lovelace', amount: '6' }]);
  });

  it('counts a fee leg against the holding', () => {
    // The old model had a single fee field and could not express a fee paid
    // in an asset other than the one traded.
    const holdings = foldHoldings(
      [
        event({
          kind: 'trade',
          legs: [
            leg({ assetId: 'eth:native', amount: '1', direction: 'in' }),
            leg({
              assetId: 'cardano:lovelace',
              amount: '100',
              direction: 'out',
            }),
            leg({
              assetId: 'eth:usdc',
              amount: '2.5',
              direction: 'out',
              role: 'fee',
            }),
          ],
        }),
      ],
      owned,
    );
    expect(holdings).toEqual([
      { assetId: 'cardano:lovelace', amount: '-100' },
      { assetId: 'eth:native', amount: '1' },
      { assetId: 'eth:usdc', amount: '-2.5' },
    ]);
  });

  it('holds 18-decimal amounts exactly across a long fold', () => {
    // Review Focus 2: a float fold drifts, and the drift ends up in a tax
    // report. 1000 x 0.000000000000000001 must be exactly 1e-15.
    const events = Array.from({ length: 1000 }, () =>
      event({
        legs: [leg({ assetId: 'eth:native', amount: '0.000000000000000001' })],
      }),
    );
    expect(foldHoldings(events, owned)).toEqual([
      { assetId: 'eth:native', amount: '0.000000000000001' },
    ]);
  });

  it('drops an asset that nets to zero rather than listing a zero holding', () => {
    const holdings = foldHoldings(
      [
        event({ legs: [leg({ amount: '5', direction: 'in' })] }),
        event({ legs: [leg({ amount: '5', direction: 'out' })] }),
      ],
      owned,
    );
    expect(holdings).toEqual([]);
  });

  it('sorts by assetId so the output is stable', () => {
    const holdings = foldHoldings(
      [
        event({ legs: [leg({ assetId: 'z:one', amount: '1' })] }),
        event({ legs: [leg({ assetId: 'a:one', amount: '1' })] }),
      ],
      owned,
    );
    expect(holdings.map((h) => h.assetId)).toEqual(['a:one', 'z:one']);
  });
});

describe('internal transfers', () => {
  it('recognises a movement between two owned venues', () => {
    const moved = event({
      kind: 'transfer',
      legs: [
        leg({ amount: '10', direction: 'out', venue: 'wallet-1' }),
        leg({ amount: '10', direction: 'in', venue: 'wallet-2' }),
      ],
    });
    expect(isInternalTransfer(moved, owned)).toBe(true);
  });

  it('does not treat a send to someone else as internal', () => {
    const sent = event({
      kind: 'transfer',
      legs: [
        leg({ amount: '10', direction: 'out', venue: 'wallet-1' }),
        leg({ amount: '10', direction: 'in', venue: 'addr-of-a-stranger' }),
      ],
    });
    expect(isInternalTransfer(sent, owned)).toBe(false);
  });

  it('excludes internal transfers from disposals', () => {
    // Review Focus 3. Counting a move between your own wallets as a disposal
    // makes every tax number downstream wrong.
    const internal = event({
      kind: 'transfer',
      legs: [
        leg({ amount: '10', direction: 'out', venue: 'wallet-1' }),
        leg({ amount: '10', direction: 'in', venue: 'wallet-2' }),
      ],
    });
    const realSale = event({
      kind: 'trade',
      legs: [
        leg({ amount: '10', direction: 'out', venue: 'wallet-1' }),
        leg({
          assetId: 'fiat:eur',
          amount: '250',
          direction: 'in',
          venue: 'wallet-1',
        }),
      ],
    });

    const disposals = foldDisposals([internal, realSale], owned);

    expect(disposals).toHaveLength(1);
    expect(disposals[0].id).toBe(realSale.id);
  });

  it('leaves an internal transfer net-neutral in the holdings', () => {
    const internal = event({
      kind: 'transfer',
      legs: [
        leg({ amount: '10', direction: 'out', venue: 'wallet-1' }),
        leg({ amount: '10', direction: 'in', venue: 'wallet-2' }),
      ],
    });
    expect(foldHoldings([internal], owned)).toEqual([]);
  });

  it('still charges the network fee on an internal transfer', () => {
    // The move is not a disposal, but the fee genuinely leaves the holding.
    const internal = event({
      kind: 'transfer',
      legs: [
        leg({ amount: '10', direction: 'out', venue: 'wallet-1' }),
        leg({ amount: '10', direction: 'in', venue: 'wallet-2' }),
        leg({
          amount: '0.17',
          direction: 'out',
          venue: 'wallet-1',
          role: 'fee',
        }),
      ],
    });
    expect(foldHoldings([internal], owned)).toEqual([
      { assetId: 'cardano:lovelace', amount: '-0.17' },
    ]);
  });

  it('still treats a genuine two-sided owned-to-owned transfer as internal and not a disposal', () => {
    const internal = event({
      kind: 'transfer',
      legs: [
        leg({ amount: '10', direction: 'out', venue: 'wallet-1' }),
        leg({ amount: '10', direction: 'in', venue: 'wallet-2' }),
      ],
    });

    expect(isInternalTransfer(internal, owned)).toBe(true);
    expect(foldDisposals([internal], owned)).toEqual([]);
  });

  it('does not treat a UTXO spend with change returning to the sender as internal', () => {
    // The shape every real Cardano payment has: the whole input is spent
    // and the change comes back to the same address, so BOTH an owned
    // out-leg and an owned in-leg are present. Classifying on leg presence
    // alone made every such spend "internal" and hid it from disposals -
    // against the 36 recorded preprod fixtures, 20 of 33 events were
    // misclassified and not one disposal survived. Only the NET per asset
    // distinguishes a payment from a move between the user's own wallets.
    const spend = event({
      kind: 'transfer',
      legs: [
        leg({ amount: '500', direction: 'out', venue: 'wallet-1' }),
        leg({ amount: '398', direction: 'in', venue: 'wallet-1' }),
      ],
    });

    expect(isInternalTransfer(spend, owned)).toBe(false);
    expect(foldDisposals([spend], owned)).toEqual([spend]);
    // 102 is what actually left the user's control, and that is what the
    // fold reports as the holding change for this event.
    expect(foldHoldings([spend], owned)).toEqual([
      { assetId: 'cardano:lovelace', amount: '-102' },
    ]);
  });

  it('treats a self-send whose change is short by the implicit chain fee as a disposal of the fee', () => {
    // cardano-yaci emits principal legs only: on a UTXO chain the network
    // fee is the input/output difference, never a leg of its own. So a
    // genuine self-send nets a small negative equal to the fee and is
    // reported as a disposal of exactly that amount. That is the correct
    // answer - the fee really did leave the user's control - and this test
    // exists so nobody "fixes" it back into a net-zero special case.
    const selfSendWithImplicitFee = event({
      kind: 'transfer',
      legs: [
        leg({ amount: '500', direction: 'out', venue: 'wallet-1' }),
        leg({ amount: '499.83', direction: 'in', venue: 'wallet-1' }),
      ],
    });

    expect(isInternalTransfer(selfSendWithImplicitFee, owned)).toBe(false);
    expect(foldDisposals([selfSendWithImplicitFee], owned)).toEqual([
      selfSendWithImplicitFee,
    ]);
    expect(foldHoldings([selfSendWithImplicitFee], owned)).toEqual([
      { assetId: 'cardano:lovelace', amount: '-0.17' },
    ]);
  });

  it('treats a self-send back to the same venue as internal when it nets exactly zero', () => {
    // No implicit fee in this shape (an exchange withdrawal to the same
    // account, or a chain where the fee is modelled as its own leg): one
    // venue, both directions, net zero. Nothing was disposed of.
    const selfSend = event({
      kind: 'transfer',
      legs: [
        leg({ amount: '500', direction: 'out', venue: 'wallet-1' }),
        leg({ amount: '500', direction: 'in', venue: 'wallet-1' }),
      ],
    });

    expect(isInternalTransfer(selfSend, owned)).toBe(true);
    expect(foldDisposals([selfSend], owned)).toEqual([]);
  });

  it('is not internal when one asset nets zero but another does not', () => {
    // A multi-asset UTXO spend: the lovelace change comes back in full
    // while a native token is genuinely sent away. Netting per asset - not
    // across all of them - is what catches this.
    const mixed = event({
      kind: 'transfer',
      legs: [
        leg({ amount: '500', direction: 'out', venue: 'wallet-1' }),
        leg({ amount: '500', direction: 'in', venue: 'wallet-1' }),
        leg({
          assetId: 'cardano:policy1.TOKEN',
          amount: '9000000',
          direction: 'out',
          venue: 'wallet-1',
        }),
      ],
    });

    expect(isInternalTransfer(mixed, owned)).toBe(false);
    expect(foldDisposals([mixed], owned)).toEqual([mixed]);
  });

  it('nets 18-decimal legs exactly rather than through a float', () => {
    // A float would collapse these two to equal and call the transfer
    // internal, hiding the disposal of the last digit.
    const dust = event({
      kind: 'transfer',
      legs: [
        leg({
          assetId: 'eth:native',
          amount: '1.000000000000000002',
          direction: 'out',
          venue: 'wallet-1',
        }),
        leg({
          assetId: 'eth:native',
          amount: '1.000000000000000001',
          direction: 'in',
          venue: 'wallet-2',
        }),
      ],
    });

    expect(isInternalTransfer(dust, owned)).toBe(false);
    expect(foldHoldings([dust], owned)).toEqual([
      { assetId: 'eth:native', amount: '-0.000000000000000001' },
    ]);
  });

  it('does not treat a single-leg outbound transfer as internal, and counts it as a disposal', () => {
    // The destination isn't a modelled venue, so only the user's own out-leg
    // is recorded. That one leg sitting at an owned venue must not make this
    // look like a move between the user's own wallets - it's a send out.
    const sentOut = event({
      kind: 'transfer',
      legs: [leg({ amount: '10', direction: 'out', venue: 'wallet-1' })],
    });

    expect(isInternalTransfer(sentOut, owned)).toBe(false);
    expect(foldDisposals([sentOut], owned)).toEqual([sentOut]);
  });
});

describe('classifying disposals', () => {
  it('does not treat a buy (fiat-out, crypto-in) as a disposal', () => {
    const buy = event({
      kind: 'trade',
      legs: [
        leg({
          assetId: 'fiat:eur',
          amount: '250',
          direction: 'out',
          venue: 'wallet-1',
        }),
        leg({
          assetId: 'cardano:lovelace',
          amount: '10',
          direction: 'in',
          venue: 'wallet-1',
        }),
      ],
    });

    expect(foldDisposals([buy], owned)).toEqual([]);
  });

  it('does not treat a bank withdrawal (fiat-out) as a disposal', () => {
    const withdrawal = event({
      kind: 'fiat-out',
      legs: [
        leg({
          assetId: 'fiat:eur',
          amount: '100',
          direction: 'out',
          venue: 'wallet-1',
        }),
      ],
    });

    expect(foldDisposals([withdrawal], owned)).toEqual([]);
  });

  it('excludes an event with no principal legs (fee-only) from disposals', () => {
    const feeOnly = event({
      kind: 'fee',
      legs: [
        leg({
          amount: '0.05',
          direction: 'out',
          venue: 'wallet-1',
          role: 'fee',
        }),
      ],
    });

    expect(foldDisposals([feeOnly], owned)).toEqual([]);
  });

  it('excludes a trade whose only qualifying leg sits at an unowned venue', () => {
    const tradeElsewhere = event({
      kind: 'trade',
      legs: [
        leg({
          amount: '10',
          direction: 'out',
          venue: 'exchange-not-mine',
        }),
        leg({
          assetId: 'fiat:eur',
          amount: '250',
          direction: 'in',
          venue: 'exchange-not-mine',
        }),
      ],
    });

    expect(foldDisposals([tradeElsewhere], owned)).toEqual([]);
  });
});
