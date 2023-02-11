import { CoinedaFile, ImportError, Transaction } from '../global/types';

export abstract class ImportSource {
  abstract name: string;
  errors: Array<ImportError> = [];
  transactions: Array<Transaction> = [];
  transfers: Array<Transaction> = [];

  static canImport(file: CoinedaFile) {
    console.warn(
      'Please override the function "static canImport(file: CoinedaFile) {}" to ensure that your custom input source will work as expected.'
    );
    return false;
  }

  abstract deserialize(file: CoinedaFile): Promise<void>;
}
