import { ReactJSXElement } from '@emotion/react/types/jsx-namespace';
import { TFunction } from 'i18next';
import {
  ImportError,
  MandatoryImportField,
  Transaction,
} from '../global/types';

export abstract class ApiSyncSource {
  abstract name: string;
  abstract label: string;
  abstract url: string;
  abstract hasDescription: boolean;
  abstract descriptionTitle?: string;
  errors: Array<ImportError> = [];
  transactions: Array<Transaction> = [];
  transfers: Array<Transaction> = [];

  abstract fetch(config?: { [key: string]: string }): Promise<void>;
  abstract getMandatoryFields(): Array<MandatoryImportField>;
  abstract getDescription(
    t: TFunction<'translation', undefined, 'translation'>
  ): ReactJSXElement;
}
