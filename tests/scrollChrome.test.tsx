import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider } from '@/components/theme/ThemeProvider';
import { AppShell } from '@/components/layout/AppShell';

/**
 * Bars that page content scrolls UNDER.
 *
 * Reported from testing: the title bar "looks oddly half transparent" once
 * the page moves beneath it, and the tax report's action bar overlapped
 * the report. Both were on Lumen's `glass-2` - a 55% white film in light
 * mode, 9% in dark - which is right for a card that sits still and wrong
 * here: the body text slides through, blurred into a smear that follows
 * the scroll.
 *
 * `glass-chrome` (src/index.css) is the surface for this case. jsdom
 * applies no CSS, so these assert the two things that can actually break:
 * the class the bars carry, and that the class exists at all.
 */
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockReturnValue({
      matches: false,
      media: '',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  );
});

const sourceFiles = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory()
      ? sourceFiles(full)
      : /\.tsx$/.test(entry.name)
        ? [full]
        : [];
  });

describe('the sticky header', () => {
  it('uses the near-opaque chrome surface, not a sheer card tier', () => {
    render(
      <ThemeProvider>
        <MemoryRouter>
          <AppShell>
            <div />
          </AppShell>
        </MemoryRouter>
      </ThemeProvider>,
    );

    const header = document.querySelector('header');
    expect(header).not.toBeNull();
    const classes = (header!.getAttribute('class') ?? '').split(/\s+/);
    expect(classes).toContain('glass-chrome');
    expect(classes).toContain('sticky');
    expect(classes).not.toContain('glass-2');
  });
});

describe('glass-chrome', () => {
  it('is a real utility, not a class name that generates nothing', () => {
    // Tailwind emits nothing for a class it cannot resolve, and a bar
    // with no background at all is a worse version of the bug this
    // replaced - so a typo here has to fail here.
    const css = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'index.css'),
      'utf8',
    );
    expect(css).toMatch(/@utility\s+glass-chrome\s*\{/);
  });

  it('is what every sticky bar in the app is on', () => {
    // The tax report's action bar is the other one, and it is reached
    // only after a full report run - far enough out of the way that a
    // regression there would not be noticed. Scanned rather than
    // rendered for that reason.
    const offenders: string[] = [];
    const files = sourceFiles(path.join(__dirname, '..', 'src'));
    expect(files.length).toBeGreaterThan(20);

    for (const file of files) {
      const contents = fs.readFileSync(file, 'utf8');
      for (const match of contents.matchAll(
        /className="([^"]*\bsticky\b[^"]*)"/g,
      )) {
        const classes = match[1].split(/\s+/);
        // Only bars pinned to an edge: `sticky` also styles table
        // headers and other things that scroll with their own container.
        const pinned = classes.some((c) => /^(top|bottom)-0$/.test(c));
        if (pinned && !classes.includes('glass-chrome')) {
          offenders.push(`${path.relative(process.cwd(), file)}: ${match[1]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
