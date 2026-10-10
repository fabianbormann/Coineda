import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (path: string) => readFileSync(path, 'utf8');

const css = read('src/index.css');
const block = (() => {
  const start = css.indexOf('@media (prefers-reduced-motion: reduce)');
  if (start === -1) return '';
  // The block ends at the first closing brace at column 0.
  return css.slice(start, css.indexOf('\n}', start));
})();

/** The selectors of the media block's rule, one per list entry. */
const selectors = block
  .slice(block.indexOf('{') + 1, block.indexOf('{', block.indexOf('{') + 1))
  .split(',')
  .map((entry) => entry.trim());

/** The families the block matches via [class*='...'] attribute selectors. */
const matched = selectors
  .map((entry) => /^\[class\*='([^']+)'\]$/.exec(entry)?.[1])
  .filter((family): family is string => Boolean(family));

const overlays = ['dialog', 'sheet', 'dropdown-menu', 'select', 'tooltip'].map(
  (name) => `src/components/ui/${name}.tsx`,
);

/** The tw-animate-css names a file uses (not other utilities, e.g. animate-spin). */
const used = (file: string): string[] => {
  const found = read(file).match(
    /(?<![\w-])(?:animate|fade|zoom|slide)-[a-z0-9-]+/g,
  );
  return [...new Set(found ?? [])].filter((name) =>
    /^(animate-(in|out)|fade-(in|out)-\d+|zoom-(in|out)-\d+|slide-(in|out)-[a-z0-9-]+)$/.test(
      name,
    ),
  );
};

describe('reduced motion', () => {
  it('has a prefers-reduced-motion block that switches animation off', () => {
    expect(block).not.toBe('');
    expect(block).toContain('animation: none !important');
    expect(block).toContain('transition-duration: 0.01ms !important');
  });

  it('covers the digit roll', () => {
    expect(selectors).toContain('.roll-strip');
  });

  it.each(overlays)(
    'matches every animation class %s uses by an attribute selector',
    (file) => {
      const names = used(file);
      expect(names.length).toBeGreaterThan(0);
      for (const name of names) {
        // A bare class selector would miss the Tailwind variant form, so the
        // class must contain one of the block's [class*=...] families.
        expect(
          matched.some((family) => name.includes(family)),
          `${name} in ${file}`,
        ).toBe(true);
      }
    },
  );
});
