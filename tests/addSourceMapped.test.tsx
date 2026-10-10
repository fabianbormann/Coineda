import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import 'fake-indexeddb/auto';
import '@/i18n';
import { AddSourceDialog } from '@/screens/AddSourceDialog';
import { ConfirmProvider } from '@/components/confirm/ConfirmProvider';

describe('the Other CSV importer', () => {
  it('opens the mapping dialog instead of the plain drop area', async () => {
    const user = userEvent.setup();
    render(
      <ConfirmProvider>
        <AddSourceDialog
          open
          onOpenChange={vi.fn()}
          onCreated={vi.fn()}
          onImportFile={vi.fn()}
          onImportMapped={vi.fn()}
        />
      </ConfirmProvider>,
    );
    const dialog = await screen.findByRole('dialog');
    await user.click(
      within(dialog).getByRole('button', { name: /other csv/i }),
    );
    const mapping = await screen.findByRole('dialog');
    expect(within(mapping).getByText('Map the columns')).toBeInTheDocument();
    expect(within(mapping).getByLabelText('Venue label')).toBeInTheDocument();
  });
});
