import { describe, it, expect, afterEach, vi } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import { cleanup } from '@testing-library/react';
import axe from 'axe-core';
import { recipes } from './helpers/recipes';

/**
 * The accessibility gate: every screen, onboarding step and dialog (the
 * coverage test below says exactly which files that is), rendered by a
 * recipe in tests/helpers/recipes.tsx, has no axe violation of WCAG 2.0/2.1
 * A or AA.
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

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });

const src = join(__dirname, '..', 'src');

/**
 * Every file that renders a screen or an overlay, by four rules:
 * `src/**\/*Dialog.tsx`, `src/screens/*Screen.tsx`, `src/onboarding/*.tsx`,
 * and any other file that renders a dialog, alert dialog or sheet inline
 * (`<DialogContent`, `<AlertDialogContent`, `<SheetContent`), such as the
 * DATEV dialog inside TaxReportScreen. The vendored primitives in
 * src/components/ui are what those files use, not screens themselves.
 */
const coveredFiles = (): string[] =>
  walk(src).filter((path) => {
    const rel = relative(src, path).split(sep).join('/');
    if (!rel.endsWith('.tsx') || rel.startsWith('components/ui/')) return false;
    return (
      rel.endsWith('Dialog.tsx') ||
      /^screens\/[^/]+Screen\.tsx$/.test(rel) ||
      /^onboarding\/[^/]+\.tsx$/.test(rel) ||
      /<(Alert)?DialogContent\b|<SheetContent\b/.test(
        readFileSync(path, 'utf8'),
      )
    );
  });

/** A recipe names a component when its name contains it as a whole word. */
const names = (recipeName: string, component: string) =>
  new RegExp(`\\b${component}\\b`).test(recipeName);

describe('recipe coverage', () => {
  it('has a recipe for every screen, onboarding step and dialog', () => {
    const files = coveredFiles();
    const rel = files.map((file) => relative(src, file).split(sep).join('/'));
    // The scan is not vacuous: each rule finds what it is meant to.
    expect(rel).toEqual(
      expect.arrayContaining([
        'screens/MainScreen.tsx',
        'screens/TaxReportScreen.tsx',
        'onboarding/OnboardingFlow.tsx',
        'onboarding/StartFresh.tsx',
        'onboarding/ImportCheckpoint.tsx',
        'screens/AddSourceDialog.tsx',
        'clients/ClientMenu.tsx',
        'components/confirm/ConfirmProvider.tsx',
      ]),
    );
    const missing = files
      .map((file) => basename(file, '.tsx'))
      .filter((name) => !recipes.some((r) => names(r.name, name)));
    expect(missing, `no axe recipe names: ${missing.join(', ')}`).toEqual([]);
  });

  it('scans the German report and its DATEV dialog, not only the stub module', () => {
    const recipeNames = recipes.map((r) => r.name);
    expect(recipeNames).toContain('TaxReportScreen report step (Germany)');
    expect(recipeNames).toContain('TaxReportScreen DATEV dialog (Germany)');
    expect(recipeNames).toContain(
      'DatevSettingsCard within TaxReportScreen setup (Germany)',
    );
  });
});
