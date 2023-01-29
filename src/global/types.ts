export type NavigationItemProps = {
  title: string;
  location: string;
  icon: JSX.Element;
};

export type CoinedaAccount = {
  id: number;
  name: string;
  pattern: number;
};

export type CoinedaSettings = {
  backendUrl: string;
  account: CoinedaAccount;
};

export type ApplicationSettings = {
  settings: CoinedaSettings;
  setSettings: (settings: CoinedaSettings) => void;
};

export type CoinSummary = {
  value: number;
  purchase_prices: [number];
  avg_purchase_price: number;
  price_in_euro: number;
  current_price: number;
  name: string;
};

export type CoinedaSummary = {
  cryptocurrencies: {
    [key: string]: CoinSummary;
  };
  fiat: { [key: string]: { value: number } };
  crypto_total_in_euro?: number;
  inconsistency?: { negativeValue: Array<CoinSummary> };
};

export type TransactionType =
  | 'buy'
  | 'sell'
  | 'send'
  | 'receive'
  | 'rewards'
  | 'swap'
  | 'transfer';

export type Transaction = {
  id: number;
  value: number;
  symbol: string;
  currency: string;
  exchange: string;
  fromExchange: string;
  toExchange: string;
  fromSymbol: string;
  toSymbol: string;
  fromValue: number;
  fromCurrency: string;
  toValue: number;
  toCurrency: string;
  feeValue: number;
  feeCurrency: string;
  type: TransactionType;
  date: number;
  formattedDate: string;
  children: Array<Transaction>;
  parent: number;
  key: number;
};

export type CoinedaAsset = {
  id: string;
  symbol: string;
  isFiat: number;
};

export type CoinedaAssets = {
  fiat: Array<CoinedaAsset>;
  cryptocurrencies: Array<CoinedaAsset>;
};

export type TransactionBucket = {
  label: string;
  days: number;
  operations: Array<Transaction>;
};

export type TransactionCardContent = {
  symbol?: JSX.Element;
  title?: string;
  description?: string;
};

export type MessageType = 'success' | 'error' | 'warning' | 'info';
export type AccountDialogMode = 'add' | 'edit';

export type TokenCache = { entries: any; age: number };
export type Token = {
  id: string;
  symbol: string;
  name: string;
};
export type CoinGekoCoinList = Array<Token>;
export type TransactionDialogProps = {
  overrides?: Transaction;
  visible: boolean;
  onClose: () => void;
};

export type ExchangeManagerProps = {
  onExchangeSelected: (exchange: string | null) => void;
  defaultSelectionIndex?: number;
  label?: string;
  showAddExchangeButton?: boolean;
  refreshExchanges?: number;
  forceRefreshExchanges?: () => void;
};

export type Exchange = {
  id: number;
  name: string;
};

export type ImportDialogProps = {
  visible: boolean;
  onClose: () => void;
};

export interface TaxTransaction extends Transaction {
  gain: number;
}

export type TaxSummary = {
  realizedGains: { [key: string]: Array<TaxTransaction> };
  unrealizedGains: { [key: string]: Array<TaxTransaction> };
};

export type GainSummaryProps = {
  gains: { [key: string]: Array<TaxTransaction> };
  showUnrealizedGains: boolean;
};
