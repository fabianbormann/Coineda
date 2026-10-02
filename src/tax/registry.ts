import austrianTax from './jurisdictions/at';
import germanTax from './jurisdictions/de';
import type { TaxModule } from './types';

/**
 * Jurisdictions ship in the bundle and arrive by reviewed pull request, for
 * the same reason source modules do: this code runs beside the user's own
 * financial history, and a runtime-loaded rule set would be arbitrary code
 * execution next to it. The conformance gate in tests/taxConformance.test.ts
 * iterates this array, so a jurisdiction cannot merge without passing.
 */
export const taxRegistry: TaxModule[] = [germanTax, austrianTax];

export const findTaxModule = (id: string): TaxModule | undefined =>
  taxRegistry.find((module) => module.manifest.id === id);
