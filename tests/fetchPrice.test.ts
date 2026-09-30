import { describe, it, expect, vi, beforeEach, type Mocked } from 'vitest';
// src/helper/common.js imports src/persistence/storage.js, which opens
// indexedDB at module load time - needed here even though this file never
// touches storage directly.
import 'fake-indexeddb/auto';
import axios from 'axios';
import { fetchPrice } from '../src/helper/common';

vi.mock('axios');

describe('fetchPrice', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  it('returns an empty map for an empty id list without making a request', async () => {
    // Every brand-new account starts with no crypto transactions, so
    // Dashboard calls fetchPrice([]) on first load. Building
    // '?ids=&vs_currencies=eur' would fail against CoinGecko, so this must
    // short-circuit before axios is ever touched.
    const result = await fetchPrice([]);

    expect(result).toEqual({});
    expect(axios.get).not.toHaveBeenCalled();
  });

  it('still fetches a keyed map for a non-empty id list', async () => {
    (axios as Mocked<typeof axios>).get.mockResolvedValueOnce({
      data: { bitcoin: { eur: 50000 } },
    });

    const result = await fetchPrice(['bitcoin']);

    expect(result).toEqual({ bitcoin: 50000 });
    expect(axios.get).toHaveBeenCalledTimes(1);
  });
});
