import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  ThemeProvider,
  useTheme,
  THEME_STORAGE_KEY,
} from '@/components/theme/ThemeProvider';
import { ThemeToggle } from '@/components/theme/ThemeToggle';

/** Controllable prefers-color-scheme mock with a live change listener. */
function mockSystemTheme(dark: boolean) {
  const listeners = new Set<(e: MediaQueryListEvent) => void>();
  const mql = {
    matches: dark,
    media: '(prefers-color-scheme: dark)',
    addEventListener: (_: string, l: (e: MediaQueryListEvent) => void) =>
      void listeners.add(l),
    removeEventListener: (_: string, l: (e: MediaQueryListEvent) => void) =>
      void listeners.delete(l),
  };
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockReturnValue(mql as unknown as MediaQueryList),
  );
  return {
    emit(nowDark: boolean) {
      mql.matches = nowDark;
      listeners.forEach((l) => l({ matches: nowDark } as MediaQueryListEvent));
    },
  };
}

const Probe = () => {
  const { theme, resolved } = useTheme();
  return <span data-testid="probe">{`${theme}:${resolved}`}</span>;
};

beforeEach(() => {
  localStorage.clear();
  document.documentElement.classList.remove('dark');
  vi.unstubAllGlobals();
});

describe('theme resolution', () => {
  it('defaults to system and follows prefers-color-scheme', () => {
    mockSystemTheme(true);
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('probe')).toHaveTextContent('system:dark');
    expect(document.documentElement).toHaveClass('dark');
  });

  it('follows a live OS change while system is selected', () => {
    const sys = mockSystemTheme(false);
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(document.documentElement).not.toHaveClass('dark');

    act(() => sys.emit(true));

    expect(screen.getByTestId('probe')).toHaveTextContent('system:dark');
    expect(document.documentElement).toHaveClass('dark');
  });

  it('lets an explicit choice override the OS and persists it', async () => {
    mockSystemTheme(true);
    render(
      <ThemeProvider>
        <Probe />
        <ThemeToggle />
      </ThemeProvider>,
    );

    await userEvent.click(screen.getByRole('button', { name: /light/i }));

    expect(screen.getByTestId('probe')).toHaveTextContent('light:light');
    expect(document.documentElement).not.toHaveClass('dark');
    expect(localStorage.getItem('coineda.theme')).toBe('light');
  });

  it('falls back to system when localStorage throws', () => {
    mockSystemTheme(true);
    const spy = vi
      .spyOn(Storage.prototype, 'getItem')
      .mockImplementation(() => {
        throw new Error('blocked');
      });

    expect(() =>
      render(
        <ThemeProvider>
          <Probe />
        </ThemeProvider>,
      ),
    ).not.toThrow();
    expect(screen.getByTestId('probe')).toHaveTextContent('system:dark');

    spy.mockRestore();
  });
});

describe('pre-paint theme script', () => {
  const html = fs.readFileSync(
    path.join(__dirname, '..', 'index.html'),
    'utf8',
  );

  it('runs inline, before the module bundle', () => {
    const inlineAt = html.indexOf('coineda.theme');
    const moduleAt = html.indexOf('src="/src/index.tsx"');
    expect(inlineAt).toBeGreaterThan(-1);
    expect(moduleAt).toBeGreaterThan(-1);
    expect(inlineAt).toBeLessThan(moduleAt);
  });

  it('uses the same storage key as ThemeProvider', () => {
    expect(html).toContain(THEME_STORAGE_KEY);
  });
});

describe('pre-paint theme script logic', () => {
  // Extracted rather than re-implemented, so this test exercises the exact
  // code index.html ships, not a copy that could drift from it. The first
  // bare `<script>` tag is the inline IIFE; the module script tag carries
  // a `type="module"` attribute, so it does not match this pattern.
  const html = fs.readFileSync(
    path.join(__dirname, '..', 'index.html'),
    'utf8',
  );
  const scriptBody = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';

  const mockMatchMedia = (matches: boolean) => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockReturnValue({
        matches,
        media: '(prefers-color-scheme: dark)',
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    );
  };

  /** Runs the extracted IIFE and reports whether it applied `.dark`. */
  const runScript = (): boolean => {
    document.documentElement.classList.remove('dark');
    expect(scriptBody).not.toBe('');
    new Function(scriptBody)();
    return document.documentElement.classList.contains('dark');
  };

  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove('dark');
  });

  it('resolves dark for an explicit "dark" preference, regardless of the OS', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    mockMatchMedia(false);
    expect(runScript()).toBe(true);
  });

  it('resolves light for an explicit "light" preference, regardless of the OS', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'light');
    mockMatchMedia(true);
    expect(runScript()).toBe(false);
  });

  it('follows the OS for "system"', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'system');
    mockMatchMedia(true);
    expect(runScript()).toBe(true);
    mockMatchMedia(false);
    expect(runScript()).toBe(false);
  });

  it('follows the OS when nothing is stored', () => {
    mockMatchMedia(true);
    expect(runScript()).toBe(true);
    mockMatchMedia(false);
    expect(runScript()).toBe(false);
  });

  it('follows the OS for a corrupted/unrecognised stored value', () => {
    // Regression guard for FIX 2: the previous condition
    // (`stored === 'system' || !stored`) treated any other truthy string
    // as light, so a corrupted value resolved to light pre-paint even on
    // a dark-preference machine - exactly the flash this script exists to
    // prevent.
    localStorage.setItem(THEME_STORAGE_KEY, 'blue');
    mockMatchMedia(true);
    expect(runScript()).toBe(true);
    mockMatchMedia(false);
    expect(runScript()).toBe(false);
  });
});

/**
 * What the BROWSER paints, which no class in this app can reach: the
 * caret, the selection pair, scrollbars, the controls inside a native
 * input. All of it resolves light unless `color-scheme` says otherwise,
 * and the app ships a dark theme.
 */
describe('color-scheme', () => {
  const css = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'index.css'),
    'utf8',
  );

  it('is declared for both themes, not left to the default', () => {
    expect(css).toMatch(/:root\s*\{[^}]*color-scheme:\s*light/);
    expect(css).toMatch(/\.dark\s*\{\s*color-scheme:\s*dark/);
  });
});

/**
 * A field must never hide what is typed into it.
 *
 * shadcn's Input carried `selection:text-primary-foreground`, and that
 * token is Lumen's `--lm-on-fill` - the inverse of the page text, #f6f7fa
 * in light mode and #0b0c10 in dark. It pairs with the solid `bg-primary`
 * highlight, but Android renders text being composed in a highlight that
 * takes the colour WITHOUT that background: every character came out
 * near-white on white, or black on a dark field. Reported twice from a
 * real phone before it was found.
 */
describe('the text field', () => {
  const sourceFiles = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      return entry.isDirectory()
        ? sourceFiles(full)
        : /\.tsx?$/.test(entry.name)
          ? [full]
          : [];
    });

  it('sets no selection colour of its own, anywhere in the app', () => {
    // Every field, not just the Input: SourceForm keeps its own copy of
    // these classes for a textarea, and it shipped the same pair.
    const source = sourceFiles(path.join(__dirname, '..', 'src'))
      .map((file) => fs.readFileSync(file, 'utf8'))
      .join('\n');
    // Comments stripped first: the one above the component names the
    // classes it removed and why, which a raw scan would read as the
    // classes still being there.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(code.match(/selection:[\w/[\]-]+/g) ?? []).toEqual([]);
  });
});
