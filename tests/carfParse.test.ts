import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { CATEGORY_ELEMENTS, CarfParseError, parseCarf } from '@/carf/parse';
import {
  DOC_TYPES,
  EXCHANGE_TYPES,
  MESSAGE_TYPES,
  TRANSFER_IN_TYPES,
  TRANSFER_OUT_TYPES,
  labelOfCode,
} from '@/carf/codes';

const fixture = (name: string): string =>
  readFileSync(path.join(__dirname, 'assets', 'carf', name), 'utf8');

const parseError = (text: string): CarfParseError => {
  try {
    parseCarf(text);
  } catch (error) {
    expect(error).toBeInstanceOf(CarfParseError);
    return error as CarfParseError;
  }
  throw new Error('expected parseCarf to throw');
};

describe('parseCarf: the plain message', () => {
  const message = parseCarf(fixture('plain.xml'));

  it('reads the message header', () => {
    expect(message.messageRefId).toBe('DE2026BITPANDA0001');
    expect(message.messageTypeIndic).toBe('CARF701');
    expect(message.reportingPeriod).toBe('2026-12-31');
    expect(message.year).toBe(2026);
    expect(message.timestamp).toBe('2027-03-15T10:20:30');
    expect(message.transmittingCountry).toBe('DE');
    expect(message.receivingCountry).toBe('DE');
  });

  it('reads the provider', () => {
    expect(message.provider).toEqual({
      name: 'Bitpanda GmbH',
      docRefId: 'DE2026RCASP01',
    });
  });

  it('reads both users in document order', () => {
    expect(message.users).toHaveLength(2);
    expect(message.users.map((u) => u.docRefId)).toEqual([
      'DE2026U0001',
      'DE2026U0002',
    ]);
  });

  it('reads an individual user with its TINs and assets', () => {
    const [a] = message.users;
    expect(a.name).toBe('Erika Mustermann');
    expect(a.docTypeIndic).toBe('OECD1');
    expect(a.tins).toEqual([
      { value: '12 345 678 901', issuedBy: 'DE' },
      { value: 'AT-123456789', issuedBy: 'AT' },
    ]);
    expect(a.assets.map((asset) => asset.name)).toEqual([
      'BTC',
      'ADA',
      'NIGHT',
      'Bitcoin',
    ]);
  });

  it('reads the fiat blocks', () => {
    const btc = message.users[0].assets[0];
    expect(btc.blocks).toEqual([
      {
        category: 'fiat-in',
        transactions: 3,
        amount: '15000.00',
        currency: 'EUR',
        units: '0.250000',
      },
      {
        category: 'fiat-out',
        transactions: 1,
        amount: '7000.00',
        currency: 'EUR',
        units: '0.100000',
      },
    ]);
  });

  it('keeps every typed block and the wallet block without a count', () => {
    const ada = message.users[0].assets[1];
    expect(ada.blocks).toEqual([
      {
        category: 'crypto-in',
        type: 'CARF403',
        transactions: 2,
        amount: '400.00',
        currency: 'EUR',
        units: '1000.000000',
      },
      {
        category: 'transfer-in',
        type: 'CARF502',
        transactions: 12,
        amount: '36.00',
        currency: 'EUR',
        units: '90.000000',
      },
      {
        category: 'transfer-in',
        type: 'CARF509',
        transactions: 1,
        amount: '200.00',
        currency: 'EUR',
        units: '500.000000',
      },
      {
        category: 'transfer-out',
        type: 'CARF606',
        transactions: 1,
        amount: '220.00',
        currency: 'EUR',
        units: '500.000000',
      },
      {
        category: 'wallet',
        amount: '220.00',
        currency: 'EUR',
        units: '500.000000',
        altValuation: 'CARF301',
      },
    ]);
    const wallet = ada.blocks[4];
    expect(wallet.transactions).toBeUndefined();
    expect('transactions' in wallet).toBe(false);
  });

  it('accepts the lower-case "to" spelling of the crypto-to-crypto blocks', () => {
    const bitcoin = message.users[0].assets[3];
    expect(bitcoin.blocks).toEqual([
      {
        category: 'crypto-out',
        transactions: 1,
        amount: '50.00',
        currency: 'USD',
        units: '0.001000',
      },
    ]);
  });

  it('reads an entity user and its RRPT block', () => {
    const b = message.users[1];
    expect(b.name).toBe('Beispiel UG');
    expect(b.tins).toEqual([{ value: '99/999/99999', issuedBy: 'DE' }]);
    expect(b.assets).toEqual([
      {
        name: 'ETH',
        blocks: [
          {
            category: 'rrpt',
            transactions: 1,
            amount: '60000.00',
            currency: 'EUR',
            units: '20.000000',
          },
        ],
      },
    ]);
  });
});

describe('parseCarf: other shapes', () => {
  it('reads a message inside the BZSt dip envelope exactly like the plain one', () => {
    expect(parseCarf(fixture('dip-envelope.xml'))).toEqual(
      parseCarf(fixture('plain.xml')),
    );
  });

  it('reads a nothing-to-report message with no users', () => {
    const message = parseCarf(fixture('nothing-to-report.xml'));
    expect(message.messageTypeIndic).toBe('CARF703');
    expect(message.users).toEqual([]);
    expect(message.provider.name).toBe('Bitpanda GmbH');
  });

  it('keeps a deleted user with its DocTypeIndic', () => {
    const message = parseCarf(fixture('deleted-user.xml'));
    expect(message.users).toHaveLength(1);
    expect(message.users[0].docTypeIndic).toBe('OECD3');
    expect(message.users[0].docRefId).toBe('DE2026U0001-DEL');
  });

  it('parses a UTF-16LE file once decoded to text', () => {
    const text = fixture('plain.xml');
    const bytes = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from(text, 'utf16le'),
    ]);
    const decoded = new TextDecoder('utf-16').decode(bytes);
    expect(parseCarf(decoded)).toEqual(parseCarf(text));
  });
});

describe('parseCarf: refusals', () => {
  it('refuses text that is not XML', () => {
    expect(parseError('not xml').key).toBe('The file is not well-formed XML.');
  });

  it('refuses XML without a CARF message', () => {
    expect(parseError('<foo/>').key).toBe(
      'No CARF message (CARF_OECD) found in this file.',
    );
  });

  it('refuses a file with two CARF messages', () => {
    const one = fixture('nothing-to-report.xml').replace(
      /^<\?xml[^>]*>\s*/,
      '',
    );
    expect(parseError(`<wrap>${one}${one}</wrap>`).key).toBe(
      'The file contains more than one CARF message.',
    );
  });

  it('refuses a non-numeric number of units and names the element', () => {
    const broken = fixture('plain.xml').replace(
      '<carf:NumberofUnits>0.250000</carf:NumberofUnits>',
      '<carf:NumberofUnits>0,25</carf:NumberofUnits>',
    );
    const error = parseError(broken);
    expect(error.key).toBe('Invalid number in {{element}}');
    expect(error.params).toEqual({ element: 'NumberofUnits', value: '0,25' });
  });

  it('refuses a non-numeric amount and a non-integer count', () => {
    const amount = fixture('plain.xml').replace(
      '<carf:Amount currCode="EUR">15000.00</carf:Amount>',
      '<carf:Amount currCode="EUR">15.000,00</carf:Amount>',
    );
    expect(parseError(amount).params?.element).toBe('Amount');
    const count = fixture('plain.xml').replace(
      '<carf:NumberofTransactions>3</carf:NumberofTransactions>',
      '<carf:NumberofTransactions>3.5</carf:NumberofTransactions>',
    );
    expect(parseError(count).params?.element).toBe('NumberofTransactions');
  });
});

describe('CARF codes', () => {
  it('maps every category element by lower-cased local name', () => {
    expect(CATEGORY_ELEMENTS).toEqual({
      cryptofiatin: 'fiat-in',
      cryptofiatout: 'fiat-out',
      cryptotocryptoin: 'crypto-in',
      cryptotocryptoout: 'crypto-out',
      cryptotransferin: 'transfer-in',
      cryptotransferout: 'transfer-out',
      transferwallet: 'wallet',
      rrpt: 'rrpt',
    });
  });

  it('labels the code lists', () => {
    expect(MESSAGE_TYPES.CARF703).toBe('Nothing to report');
    expect(Object.keys(TRANSFER_IN_TYPES)).toHaveLength(9);
    expect(Object.keys(TRANSFER_OUT_TYPES)).toHaveLength(6);
    expect(Object.keys(EXCHANGE_TYPES)).toHaveLength(4);
    expect(DOC_TYPES.OECD3).toBe('Deleted');
    expect(labelOfCode('CARF502')).toBe('Staking income');
    expect(labelOfCode('CARF606')).toBe('Unknown');
    expect(labelOfCode('CARF999')).toBe('CARF999');
  });
});
