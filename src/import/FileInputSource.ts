import { CoinedaFile, ImportError, Transaction } from '../global/types';

export abstract class FileInputSource {
  abstract name: string;
  errors: Array<ImportError> = [];
  transactions: Array<Transaction> = [];
  transfers: Array<Transaction> = [];

  // `file` is unused here but documents the signature subclasses must implement.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  static canImport(file: CoinedaFile) {
    console.warn(
      'Please override the function "static canImport(file: CoinedaFile) {}" to ensure that your custom input source will work as expected.',
    );
    return false;
  }

  abstract deserialize(file: CoinedaFile): Promise<void>;
}
