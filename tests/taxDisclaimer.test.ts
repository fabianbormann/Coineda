import { describe, it, expect } from 'vitest';
import { buildDisclaimer } from '@/tax/disclaimer';
import germanTax from '@/tax/jurisdictions/de';

describe('buildDisclaimer', () => {
  it('names the contributor and the date the rules were checked', () => {
    const disclaimer = buildDisclaimer(
      germanTax.manifest,
      Date.UTC(2026, 9, 1),
    );
    expect(disclaimer.contributor).toBe('Fabian Bormann');
    expect(disclaimer.rulesCheckedOn).toBe('2026-10-01');
    expect(disclaimer.references).toContain('§23 Abs. 1 Nr. 2 EStG');
  });

  it('computes how stale the rules are rather than warning statically', () => {
    // "last checked 19 months ago" tells a reader something a fixed
    // warning never does, and the age is the actual information.
    const disclaimer = buildDisclaimer(
      { ...germanTax.manifest, rulesCheckedOn: '2025-03-01' },
      Date.UTC(2026, 9, 1),
    );
    expect(disclaimer.monthsSinceChecked).toBe(19);
    expect(disclaimer.stale).toBe(true);
  });

  it('does not call freshly checked rules stale', () => {
    const disclaimer = buildDisclaimer(
      { ...germanTax.manifest, rulesCheckedOn: '2026-09-01' },
      Date.UTC(2026, 9, 1),
    );
    expect(disclaimer.monthsSinceChecked).toBe(1);
    expect(disclaimer.stale).toBe(false);
  });

  it('states that it is a community contribution, not advice', () => {
    const disclaimer = buildDisclaimer(
      germanTax.manifest,
      Date.UTC(2026, 9, 1),
    );
    expect(disclaimer.noticeKey).toBeTruthy();
  });
});

describe('the German module cites what is in force', () => {
  it('names the BMF letter currently in force, not the one it replaced', () => {
    // The 2022 letter was re-issued on 2025-03-06. Citing the superseded
    // one while `rulesCheckedOn` claimed a 2026 review was a contradiction
    // the disclaimer surface exists to prevent: the freshness signal was
    // true and the citation behind it was three years stale.
    const references = germanTax.manifest.references.join(' ');
    expect(references).toContain('BMF 06.03.2025');
    expect(references).not.toContain('BMF 10.05.2022');
  });

  it('cites the loss-carry-forward rule it now implements', () => {
    expect(germanTax.manifest.references).toContain('§23 Abs. 3 Satz 7-8 EStG');
  });
});
