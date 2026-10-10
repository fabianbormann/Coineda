import { describe, it, expect, afterEach, vi } from 'vitest';
import { readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { cleanup } from '@testing-library/react';
import axe from 'axe-core';
import { recipes } from './helpers/recipes';

/**
 * The accessibility gate: every screen and dialog, rendered by a recipe in
 * tests/helpers/recipes.tsx, has no axe violation of WCAG 2.0/2.1 A or AA.
 *
 * jsdom does no layout or painting, so this catches structure (names,
 * roles, labels, ARIA, landmarks, headings) and not what only a browser
 * can see. docs/accessibility.md says what is off and why.
 */
const options: axe.RunOptions = {
  runOnly: {
    type: 'tag',
    values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'],
  },
  rules: {
    // jsdom computes no colours, so axe cannot compare them. Contrast is
    // measured from the tokens instead: tests/contrast.test.ts and the
    // table in docs/accessibility.md.
    'color-contrast': { enabled: false },
  },
};

const describeViolations = (violations: axe.Result[]) =>
  violations
    .map(
      (v) =>
        `${v.id}: ${v.help}\n    ${v.nodes[0]?.html ?? '(no node)'}` +
        (v.nodes.length > 1 ? `\n    (+${v.nodes.length - 1} more)` : ''),
    )
    .join('\n');

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('axe gate', () => {
  for (const recipe of recipes) {
    it(`${recipe.name} has no WCAG 2.1 A/AA violations`, async () => {
      await recipe.render();
      const results = await axe.run(document.body, options);
      expect(
        results.violations,
        `${recipe.name}:\n${describeViolations(results.violations)}`,
      ).toEqual([]);
    }, 20_000);
  }
});

const dialogFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return dialogFiles(path);
    return entry.endsWith('Dialog.tsx') ? [path] : [];
  });

describe('recipe coverage', () => {
  it('has a recipe for every src/**/*Dialog.tsx', () => {
    const files = dialogFiles(join(__dirname, '..', 'src'));
    expect(files.length).toBeGreaterThan(0);
    const missing = files
      .map((file) => basename(file, '.tsx'))
      .filter((name) => !recipes.some((r) => r.name.includes(name)));
    expect(missing, `no axe recipe names: ${missing.join(', ')}`).toEqual([]);
  });
});
