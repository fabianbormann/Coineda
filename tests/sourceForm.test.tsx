import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@/i18n';
import { SourceForm } from '@/screens/SourceForm';
import type { SourceModule } from '@/sources/types';

/**
 * The advanced disclosure.
 *
 * A field a typical user does not need should not crowd the form, but it
 * must still be reachable - and, crucially, must not LOOK absent when it
 * already holds a value, which is the edit case for every source configured
 * before the advanced field existed.
 */
const moduleWith = (fields: SourceModule['manifest']['fields']): SourceModule =>
  ({
    manifest: {
      id: 'test-advanced',
      kind: 'chain',
      label: 'Test Advanced',
      fields,
      needsRelay: false,
      emits: ['transfer'],
      docsUrl: 'https://example.org',
    },
    probe: vi.fn(),
    fetchEvents: vi.fn(),
  }) as unknown as SourceModule;

const PLAIN = {
  name: 'primary',
  label: 'Primary field',
  type: 'text' as const,
  help: 'The ordinary one.',
};
const ADVANCED = {
  name: 'extra',
  label: 'Extra field',
  type: 'addressList' as const,
  help: 'The advanced one.',
  advanced: true,
};

const renderForm = (config: Record<string, string>) =>
  render(
    <SourceForm
      module={moduleWith([PLAIN, ADVANCED])}
      label="Main"
      config={config}
      fieldErrors={{}}
      secretsOptional={false}
      onLabelChange={vi.fn()}
      onConfigChange={vi.fn()}
    />,
  );

describe('SourceForm advanced fields', () => {
  it('shows an ordinary field and hides an advanced one behind a switch', () => {
    renderForm({});
    expect(screen.getByLabelText('Primary field')).toBeInTheDocument();
    // Absent from the DOM rather than merely styled out: jsdom's handling of
    // hidden content is unreliable enough that "not visible" is a weaker
    // claim than "not rendered", and this is the claim that matters.
    expect(screen.queryByLabelText('Extra field')).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /advanced/i }),
    ).toBeInTheDocument();
  });

  it('reveals the advanced field when the switch is used', async () => {
    renderForm({});
    await userEvent.click(screen.getByRole('button', { name: /advanced/i }));
    expect(screen.getByLabelText('Extra field')).toBeInTheDocument();
    // Still a textarea, i.e. the field TYPE is rendered by the same code
    // whether or not it sits behind the disclosure.
    expect(screen.getByLabelText('Extra field').tagName).toBe('TEXTAREA');
  });

  it('starts OPEN when the advanced field already holds a value', () => {
    // The edit case. A source configured by address list before the xpub
    // field existed would otherwise open looking empty, and its own
    // configuration would be invisible until the user went hunting.
    renderForm({ extra: 'bc1qexisting' });
    expect(screen.getByLabelText('Extra field')).toBeInTheDocument();
    expect(screen.getByLabelText('Extra field')).toHaveValue('bc1qexisting');
  });

  it('stays closed when the advanced field holds only whitespace', () => {
    // An optional field is stored exactly as the user left it, so a value of
    // spaces or a stray newline is "not given" and must not force the
    // disclosure open on every edit.
    renderForm({ extra: '  \n ' });
    expect(screen.queryByLabelText('Extra field')).not.toBeInTheDocument();
  });

  it('renders every field inline when none is advanced', () => {
    render(
      <SourceForm
        module={moduleWith([PLAIN, { ...ADVANCED, advanced: false }])}
        label="Main"
        config={{}}
        fieldErrors={{}}
        secretsOptional={false}
        onLabelChange={vi.fn()}
        onConfigChange={vi.fn()}
      />,
    );
    expect(screen.getByLabelText('Extra field')).toBeInTheDocument();
    // No disclosure at all when there is nothing to put behind it - an empty
    // "Advanced options" control is worse than none.
    expect(
      screen.queryByRole('button', { name: /advanced/i }),
    ).not.toBeInTheDocument();
  });
});
