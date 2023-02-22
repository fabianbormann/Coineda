import { CoinedaAccount, TaxTransaction } from '../../global/types';
import TaxCalculator from '../TaxCalculator';

export default class GermanTaxCalculator extends TaxCalculator {
  name: string = 'GermanTaxCalculator';
  label: string = 'German Tax Calculator';
  taxFreeAfterHoldingPeriod = true;

  constructor() {
    super();
    this.taxFreeThreshold = 600;
  }

  async calculate(account: CoinedaAccount, year: number) {
    await this.calculateRealizedAndUnrealizedGains(account);

    const realizedWithinTaxYear: { [key: string]: Array<TaxTransaction> } = {};
    for (const coin of Object.keys(this.realizedGains)) {
      const gains = this.realizedGains[coin].filter(
        (transaction) =>
          new Date(transaction.date) > new Date(year, 0, 1) &&
          new Date(transaction.date) < new Date(year, 11, 31)
      );
      if (gains.length > 0) {
        realizedWithinTaxYear[coin] = gains;
      }
    }

    const unrealizedAfterTaxYear: { [key: string]: Array<TaxTransaction> } = {};
    for (const coin of Object.keys(this.unrealizedGains)) {
      const unrealizedGains = this.unrealizedGains[coin].filter(
        (transaction) =>
          new Date(new Date(transaction.date).getFullYear(), 0, 1) <=
          new Date(year, 0, 1)
      );

      if (unrealizedGains.length > 0) {
        unrealizedAfterTaxYear[coin] = unrealizedGains;
      }
    }

    let totalGain = 0;
    for (const coin of Object.keys(realizedWithinTaxYear)) {
      totalGain += realizedWithinTaxYear[coin].reduce(
        (previous, current) => previous + current.gain,
        0
      );
    }

    const isBelowLimit = totalGain < this.taxFreeThreshold;

    return {
      realizedGains: realizedWithinTaxYear,
      unrealizedGains: unrealizedAfterTaxYear,
      totalGain: this.roundFiat(totalGain),
      hasLoss: totalGain < 0,
      isBelowLimit: isBelowLimit,
      tax: this.roundFiat(isBelowLimit ? 0 : totalGain * 0.5),
    };
  }
}
