import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { render, screen } from '@testing-library/react';
import { ExternalLink } from '@/components/ExternalLink';

const walk = (dir: string): string[] =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? walk(path.join(dir, entry.name))
        : [path.join(dir, entry.name)],
    );

describe('ExternalLink', () => {
  it('opens in a new tab without opener or referrer and says so', () => {
    render(
      <ExternalLink href="https://example.com" className="x">
        Docs
      </ExternalLink>,
    );
    const link = screen.getByRole('link');
    expect(link.getAttribute('href')).toBe('https://example.com');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link.className).toBe('x');
    expect(link.textContent).toContain('Docs');
    const cue = link.querySelector('span.sr-only');
    expect(cue?.textContent?.trim()).toBe('(opens in a new tab)');
  });

  it('forwards other anchor props', () => {
    render(
      <ExternalLink href="https://example.com" aria-label="Read the docs">
        Docs
      </ExternalLink>,
    );
    expect(screen.getByRole('link').getAttribute('aria-label')).toBe(
      'Read the docs',
    );
  });

  it('is the only place in src that sets target="_blank"', () => {
    const offenders = walk(path.join(__dirname, '../src'))
      .filter((file) => file.endsWith('.tsx'))
      .filter((file) =>
        fs.readFileSync(file, 'utf8').includes('target="_blank"'),
      )
      .map((file) => path.basename(file));
    expect(offenders).toEqual(['ExternalLink.tsx']);
  });
});
