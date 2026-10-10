/**
 * A small CSV reader, to RFC 4180's rules.
 *
 * Hand-rolled rather than a dependency: the whole of it is the quoting
 * rules, and those are forty lines. What it must get right is that a
 * quoted field may contain commas, newlines and doubled quotes - an
 * exchange export carries free-text columns, and splitting on `,` turns one
 * such field into two columns and silently shifts every value after it into
 * the wrong one. A shifted row is not a parse error; it is a wrong number
 * that parses perfectly.
 */
export type CsvRow = Record<string, string>;

export type CsvDelimiter = ',' | ';' | '\t';

/**
 * Picks the delimiter from a header line: the most frequent of `,` `;` and
 * tab OUTSIDE double quotes (a quoted header such as "Fee (EUR; net)" must
 * not flip the answer). A tie, or no separator at all, answers `,`.
 */
export const sniffDelimiter = (headerLine: string): CsvDelimiter => {
  const counts: Record<CsvDelimiter, number> = { ',': 0, ';': 0, '\t': 0 };
  let quoted = false;
  for (const char of headerLine) {
    if (char === '"') {
      quoted = !quoted;
    } else if (!quoted && char in counts) {
      counts[char as CsvDelimiter] += 1;
    }
  }
  let best: CsvDelimiter = ',';
  for (const candidate of [';', '\t'] as const) {
    if (counts[candidate] > counts[best]) {
      best = candidate;
    }
  }
  return best;
};

/** Splits one CSV document into rows of raw fields. */
export const readCsvRows = (
  text: string,
  delimiter: CsvDelimiter = ',',
): string[][] => {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let started = false;

  const endField = () => {
    row.push(field);
    field = '';
    started = false;
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          // A doubled quote inside a quoted field is one literal quote.
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"' && !started) {
      quoted = true;
      started = true;
      continue;
    }
    if (char === delimiter) {
      endField();
      continue;
    }
    if (char === '\r') {
      // Swallowed: \r\n ends the row on the \n, and a lone \r is treated
      // as the same line ending rather than as data.
      if (text[index + 1] === '\n') {
        continue;
      }
      endRow();
      continue;
    }
    if (char === '\n') {
      endRow();
      continue;
    }
    field += char;
    started = true;
  }

  // A file that does not end in a newline still has a last row.
  if (field !== '' || row.length > 0) {
    endRow();
  }

  // A trailing newline produces one empty row, which is not a record.
  return rows.filter(
    (candidate) => candidate.length > 1 || candidate[0]?.trim() !== '',
  );
};

/**
 * Reads a CSV with a header row into objects keyed by column NAME.
 *
 * Name-keyed rather than position-keyed on purpose. An export's column
 * order is not a promise anybody made, and a parser that reads
 * `fields[8]` as the amount keeps working right up until a provider
 * inserts a column - at which point it reads the fee as the amount and
 * says nothing. Reading by name fails loudly instead, via `missing` below.
 */
/**
 * Drops a UTF-8 byte-order mark.
 *
 * Written as a code-point comparison rather than a regex with the literal
 * character in it: the literal is invisible in an editor, Prettier
 * normalises an escape back into it, and lint then rejects it as irregular
 * whitespace. The charCode says plainly what is being removed.
 */
const BOM = 0xfeff;

const stripBom = (value: string): string =>
  value.charCodeAt(0) === BOM ? value.slice(1) : value;

/**
 * The delimiter is a comma unless the caller asks otherwise. Sniffing is
 * OPT-IN on purpose: an exchange export re-saved by a German Excel carries
 * `;` between fields and decimal commas inside them, and a module that
 * strips commas as thousands separators would read `0,01` as `001`. Read
 * with commas, that file is one header cell and is refused loudly - which
 * is what every module that did not ask for `'auto'` keeps getting.
 */
export const readCsv = (
  text: string,
  options: { delimiter?: CsvDelimiter | 'auto' } = {},
): { header: string[]; rows: CsvRow[] } => {
  const requested = options.delimiter ?? ',';
  const delimiter =
    requested === 'auto'
      ? sniffDelimiter(stripBom(text).split(/\r\n|\n|\r/, 1)[0] ?? '')
      : requested;
  const raw = readCsvRows(text, delimiter);
  if (raw.length === 0) {
    return { header: [], rows: [] };
  }
  // A UTF-8 BOM arrives on the first header cell and would make that column
  // unmatchable by name - a difference nothing on screen would show.
  const header = raw[0].map((name, index) =>
    (index === 0 ? stripBom(name) : name).trim(),
  );
  const rows = raw.slice(1).map((fields) => {
    const row: CsvRow = {};
    header.forEach((name, index) => {
      row[name] = fields[index] ?? '';
    });
    return row;
  });
  return { header, rows };
};
