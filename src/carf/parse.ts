import type {
  CarfAssetReport,
  CarfBlock,
  CarfCategory,
  CarfMessage,
  CarfTin,
  CarfUser,
} from './types';

/**
 * Parse an OECD CARF XML message (schema v1.5) from text.
 *
 * Pure: no I/O, no clock. Elements are matched by lower-cased local name,
 * so namespace prefixes do not matter and both the schema's
 * `CryptoToCryptoIn` and the OECD prose's `CryptotoCryptoIn` are read. The
 * message may sit at the root or inside any wrapper (the BZSt `dip:dip`
 * delivery envelope), as long as the file holds exactly one `CARF_OECD`.
 * No XSD validation: what the reconciliation reads is checked here, the
 * rest is ignored. Decoding bytes (UTF-8, UTF-16) is the caller's concern.
 */

/** A refusal; `key` is an English translation key, `params` its values. */
export class CarfParseError extends Error {
  constructor(
    public key: string,
    public params?: Record<string, string>,
  ) {
    super(key);
    this.name = 'CarfParseError';
  }
}

/** Lower-cased local names of the block elements → their category. */
export const CATEGORY_ELEMENTS: Record<string, CarfCategory> = {
  cryptofiatin: 'fiat-in',
  cryptofiatout: 'fiat-out',
  cryptotocryptoin: 'crypto-in',
  cryptotocryptoout: 'crypto-out',
  cryptotransferin: 'transfer-in',
  cryptotransferout: 'transfer-out',
  transferwallet: 'wallet',
  rrpt: 'rrpt',
};

// Amounts and units in a CARF block are non-negative by the schema.
const DECIMAL = /^\d+(\.\d+)?$/;
const COUNT = /^\d+$/;
const DATE = /^(\d{4})-\d{2}-\d{2}/;

const nameOf = (el: Element): string => el.localName.toLowerCase();

/** Direct element children with the given lower-cased local name. */
const childrenNamed = (el: Element, name: string): Element[] =>
  Array.from(el.children).filter((child) => nameOf(child) === name);

const childNamed = (el: Element, name: string): Element | undefined =>
  childrenNamed(el, name)[0];

/** All descendants (document order) with the given lower-cased local name. */
const descendantsNamed = (el: Element, name: string): Element[] => {
  const found: Element[] = [];
  const walk = (node: Element): void => {
    for (const child of Array.from(node.children)) {
      if (nameOf(child) === name) found.push(child);
      walk(child);
    }
  };
  walk(el);
  return found;
};

const clean = (text: string | null): string =>
  (text ?? '').replace(/\s+/g, ' ').trim();

/** The trimmed text at a path of child names, or undefined if absent. */
const textOf = (el: Element, path: string[]): string | undefined => {
  let node: Element | undefined = el;
  for (const step of path) {
    node = node && childNamed(node, step);
  }
  return node ? clean(node.textContent) : undefined;
};

const required = (el: Element, path: string[], element: string): string => {
  const value = textOf(el, path);
  if (!value) {
    throw new CarfParseError('The CARF message has no {{element}}.', {
      element,
    });
  }
  return value;
};

const decimal = (value: string | undefined, element: string): string => {
  const v = (value ?? '').trim();
  if (!DECIMAL.test(v)) {
    throw new CarfParseError('Invalid number in {{element}}', {
      element,
      value: v,
    });
  }
  return v;
};

const count = (value: string | undefined, element: string): number => {
  const v = (value ?? '').trim();
  if (!COUNT.test(v)) {
    throw new CarfParseError('Invalid number in {{element}}', {
      element,
      value: v,
    });
  }
  return Number.parseInt(v, 10);
};

/**
 * A party's display name: an Individual's `FirstName LastName`, an
 * Entity's `Name` text. Takes the first `Name` element.
 */
const partyName = (party: Element): string => {
  const name = childNamed(party, 'name');
  if (!name) return '';
  if (nameOf(party) === 'individual') {
    return [textOf(name, ['firstname']), textOf(name, ['lastname'])]
      .filter((part): part is string => !!part)
      .join(' ');
  }
  return clean(name.textContent);
};

/** The `Individual` or `Entity` child of an id element. */
const partyOf = (id: Element | undefined): Element | undefined =>
  id &&
  Array.from(id.children).find((child) =>
    ['individual', 'entity'].includes(nameOf(child)),
  );

const readBlock = (el: Element, category: CarfCategory): CarfBlock => {
  const amountEl = childNamed(el, 'amount');
  const amount = decimal(amountEl?.textContent ?? undefined, 'Amount');
  // Without its currency an amount cannot be compared with anything.
  const currency = clean(amountEl?.getAttribute('currCode') ?? null);
  if (!currency) {
    throw new CarfParseError('The CARF message has no {{element}}.', {
      element: 'Amount@currCode',
    });
  }
  const type = textOf(el, ['exchangetype']) ?? textOf(el, ['transfertype']);
  const altValuation = textOf(el, ['altvaluation']);
  // Keys in a fixed order, optional ones only when present.
  return {
    category,
    ...(type ? { type } : {}),
    ...(category === 'wallet'
      ? {}
      : {
          transactions: count(
            textOf(el, ['numberoftransactions']),
            'NumberofTransactions',
          ),
        }),
    amount,
    currency,
    units: decimal(textOf(el, ['numberofunits']), 'NumberofUnits'),
    ...(altValuation ? { altValuation } : {}),
  };
};

const readAsset = (el: Element): CarfAssetReport => {
  const name = textOf(el, ['cryptoasset']);
  if (!name) {
    throw new CarfParseError('The CARF message has no {{element}}.', {
      element: 'CryptoAsset',
    });
  }
  const blocks: CarfBlock[] = [];
  for (const child of Array.from(el.children)) {
    const category = CATEGORY_ELEMENTS[nameOf(child)];
    if (category) blocks.push(readBlock(child, category));
  }
  return { name, blocks };
};

const readTins = (party: Element | undefined): CarfTin[] =>
  party
    ? childrenNamed(party, 'tin').map((tin) => {
        const issuedBy = clean(tin.getAttribute('issuedBy'));
        return issuedBy
          ? { value: clean(tin.textContent), issuedBy }
          : { value: clean(tin.textContent) };
      })
    : [];

const readUser = (el: Element): CarfUser => {
  const party = partyOf(childNamed(el, 'userid'));
  return {
    name: party ? partyName(party) : '',
    tins: readTins(party),
    docRefId: textOf(el, ['docspec', 'docrefid']) ?? '',
    docTypeIndic: textOf(el, ['docspec', 'doctypeindic']) ?? '',
    assets: childrenNamed(el, 'relevanttransactions').map(readAsset),
  };
};

export const parseCarf = (text: string): CarfMessage => {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (
    !doc.documentElement ||
    doc.getElementsByTagName('parsererror').length > 0
  ) {
    throw new CarfParseError('The file is not well-formed XML.');
  }
  const root = doc.documentElement;
  const messages =
    nameOf(root) === 'carf_oecd'
      ? [root, ...descendantsNamed(root, 'carf_oecd')]
      : descendantsNamed(root, 'carf_oecd');
  if (messages.length === 0) {
    throw new CarfParseError('No CARF message (CARF_OECD) found in this file.');
  }
  if (messages.length > 1) {
    throw new CarfParseError('The file contains more than one CARF message.');
  }
  const message = messages[0];

  const spec = childNamed(message, 'messagespec');
  if (!spec) {
    throw new CarfParseError('The CARF message has no {{element}}.', {
      element: 'MessageSpec',
    });
  }
  const reportingPeriod = required(
    spec,
    ['reportingperiod'],
    'ReportingPeriod',
  );
  const date = DATE.exec(reportingPeriod);
  if (!date) {
    throw new CarfParseError('Invalid date in {{element}}', {
      element: 'ReportingPeriod',
      value: reportingPeriod,
    });
  }

  const body = childNamed(message, 'carfbody');
  const rcasp = body && childNamed(body, 'rcasp');
  const providerParty = rcasp && partyOf(childNamed(rcasp, 'rcasp_id'));

  return {
    messageRefId: required(spec, ['messagerefid'], 'MessageRefId'),
    messageTypeIndic: required(spec, ['messagetypeindic'], 'MessageTypeIndic'),
    reportingPeriod,
    year: Number(date[1]),
    timestamp: textOf(spec, ['timestamp']) ?? '',
    transmittingCountry: textOf(spec, ['transmittingcountry']) ?? '',
    receivingCountry: textOf(spec, ['receivingcountry']) ?? '',
    provider: {
      name: providerParty ? partyName(providerParty) : '',
      docRefId: (rcasp && textOf(rcasp, ['docspec', 'docrefid'])) ?? '',
    },
    users: body ? childrenNamed(body, 'cryptousers').map(readUser) : [],
  };
};
