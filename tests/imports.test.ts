import { describe, it, expect, vi, Mocked } from 'vitest';
import 'fake-indexeddb/auto';

import path from 'path';
import fs from 'fs';
import { importFiles } from '../src/helper/import';
import axios from 'axios';

vi.mock('axios');

describe('import tests', () => {
  it('should import 9 transactions, 0 transfers and fail on one transaction because of a missing symbol ', async () => {
    const filePath = path.join(__dirname, 'assets', 'coineda-export.cnd');

    const blob = fs.readFileSync(filePath);
    const importedFile = new File([blob], 'coineda-export.cnd', {
      type: 'text/plain',
    });

    const { inserts, duplicates, errors } = await importFiles(
      [importedFile],
      0
    );

    expect(inserts).toBe(9);
    expect(duplicates).toBe(0);
    expect(errors.length).toBe(1);
  });

  it('should import 25 transactions from Binance Order History', async () => {
    const filePath = path.join(
      __dirname,
      'assets',
      'Export Order History-2021-10-01 22_52_47.xlsx'
    );

    (axios as Mocked<typeof axios>).get.mockImplementation(async (url) => {
      if (url.startsWith('https://api.coingecko.com/')) {
        return {
          data: {
            prices: [[1392595200000, 453.4532]],
          },
        };
      } else {
        return {
          data: {
            symbols: [
              {
                baseAsset: 'SOL',
                quoteAsset: 'BTC',
              },
            ],
          },
        };
      }
    });

    const blob = fs.readFileSync(filePath);
    const importedFile = new File(
      [blob],
      'Export Order History-2021-10-01 22_52_47.xlsx',
      {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }
    );

    const { inserts, duplicates, errors } = await importFiles(
      [importedFile],
      0
    );

    expect(inserts).toBe(25);
    expect(duplicates).toBe(0);
    expect(errors.length).toBe(0);
  }, 20000);

  it('should import 25 Kraken transactions from csv export', async () => {
    const filePath = path.join(
      __dirname,
      'assets',
      'KrakenExport-2021-10-05.csv'
    );

    const blob = fs.readFileSync(filePath);
    const importedFile = new File([blob], 'KrakenExport-2021-10-05.csv', {
      type: 'text/csv',
    });

    const { inserts, duplicates, errors } = await importFiles(
      [importedFile],
      0
    );

    expect(inserts).toBe(25);
    expect(duplicates).toBe(0);
    expect(errors.length).toBe(2);
  });
});
