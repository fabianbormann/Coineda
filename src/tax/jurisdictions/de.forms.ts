/**
 * Where each filing figure goes on the German forms, per form year.
 *
 * Line numbers move between years, so they are data with provenance rather
 * than constants in the calculation: a year absent from this table prints
 * its figures under the section names with no line references. Adding a
 * year is a one-entry change here and nowhere else.
 */
export type FormLinesDe = {
  verified: { source: string; checkedOn: string };
  /** Anlage SO, private Veräußerungsgeschäfte. */
  so: {
    indicator: number;
    description: number;
    period: number;
    proceeds: number;
    acquisitionCosts: number;
    expenses: number;
    result: number;
    carryOver: number;
  };
  /** Anlage SO, Leistungen (§22 Nr. 3 EStG). */
  income: {
    indicator: number;
    type: number;
    sum: number;
    expenses: number;
    result: number;
  };
  /**
   * Anlage KAP, derivatives without domestic withholding. `net` is a
   * BALANCE line (gains minus deductible losses, signed: a loss year types
   * a negative figure), and `losses` lists the losses CONTAINED in that
   * balance for the loss-offset rules - it is not a second deduction.
   */
  kap: { net: number; losses: number };
};

export const FORM_LINES_DE: Record<number, FormLinesDe> = {
  // VZ 2023 and 2024 are NOT verified (sources disagree), so they are absent.
  2025: {
    verified: { source: 'Blockpit ELSTER guide', checkedOn: '2026-10-10' },
    so: {
      indicator: 45,
      description: 46,
      period: 47,
      proceeds: 48,
      acquisitionCosts: 49,
      expenses: 50,
      result: 51,
      carryOver: 58,
    },
    income: { indicator: 14, type: 15, sum: 18, expenses: 19, result: 20 },
    kap: { net: 19, losses: 22 },
  },
};

export const linesFor = (year: number): FormLinesDe | undefined =>
  FORM_LINES_DE[year];
