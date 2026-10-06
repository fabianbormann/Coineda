import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { render, screen } from '@testing-library/react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';

/**
 * A dialog's frame must not scroll with its contents.
 *
 * `rim` draws the border as an absolutely positioned pseudo-element at
 * `inset: 0`. On a scroll container that resolves against the SCROLLABLE
 * area rather than the visible one, so the frame gets painted around the
 * full content height and its edges cut across the middle of the view as
 * you scroll - which is what a long event list looked like. The close
 * button, also absolutely positioned, scrolls away for the same reason.
 *
 * jsdom applies no CSS, so what is checked here is the STRUCTURE that makes
 * the difference: the bordered box and the scrolling box are not the same
 * element.
 */
const renderDialog = () =>
  render(
    <Dialog open>
      <DialogContent>
        <DialogTitle>Title</DialogTitle>
        <p>body</p>
      </DialogContent>
    </Dialog>,
  );

describe('the dialog frame', () => {
  it('does not scroll the element it is drawn on', () => {
    renderDialog();
    const frame = document.querySelector('[data-slot="dialog-content"]');
    expect(frame).not.toBeNull();

    const classes = (frame!.getAttribute('class') ?? '').split(/\s+/);
    // It carries the border...
    expect(classes).toContain('rim');
    // ...so it must not be the scroller.
    expect(classes).toContain('overflow-hidden');
    expect(classes).not.toContain('overflow-y-auto');
    expect(classes).not.toContain('overflow-auto');
  });

  it('scrolls an inner wrapper instead', () => {
    renderDialog();
    const body = document.querySelector('[data-slot="dialog-body"]');
    expect(body).not.toBeNull();
    const classes = (body!.getAttribute('class') ?? '').split(/\s+/);
    expect(classes).toContain('overflow-y-auto');
    // A flex item defaults to `min-height: auto`, so without this the
    // wrapper grows to its content and the height cap never bites.
    expect(classes).toContain('min-h-0');
  });

  it('keeps the close button outside the scrolling area', () => {
    // It is positioned against the frame. Inside the scroller it would
    // drift off the top as soon as the content moved.
    renderDialog();
    const close = screen.getByRole('button', { name: /close/i });
    expect(close.closest('[data-slot="dialog-body"]')).toBeNull();
    expect(close.closest('[data-slot="dialog-content"]')).not.toBeNull();
  });
});

describe('no caller reintroduces it', () => {
  /**
   * `cn` merges through tailwind-merge, so a caller passing
   * `overflow-y-auto` to DialogContent REPLACES the `overflow-hidden`
   * above and the frame starts scrolling again - with nothing failing.
   * That is exactly how it got there the first time.
   */
  const sourceFiles = (dir: string): string[] =>
    readdirSync(dir).flatMap((entry) => {
      const full = path.join(dir, entry);
      return statSync(full).isDirectory()
        ? sourceFiles(full)
        : /\.tsx$/.test(entry)
          ? [full]
          : [];
    });

  it('passes no overflow to DialogContent anywhere in src', () => {
    const files = sourceFiles(path.join(__dirname, '..', 'src'));
    // Guards the scan itself: a glob matching nothing would pass silently.
    expect(files.length).toBeGreaterThan(20);

    const offenders: string[] = [];
    for (const file of files) {
      const contents = readFileSync(file, 'utf8');
      for (const match of contents.matchAll(
        /<DialogContent[^>]*className=\{?["'`]([^"'`]*)["'`]/g,
      )) {
        if (/overflow-(y-)?auto|overflow-scroll/.test(match[1])) {
          offenders.push(`${path.relative(process.cwd(), file)}: ${match[1]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
