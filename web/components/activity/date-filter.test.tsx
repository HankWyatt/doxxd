import { expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { within } from '@testing-library/react';
import { DateFilter } from './date-filter';
import { DEMO_ADDRESS } from '@/lib/fixtures/wallet';
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
it('keeps server-rendered date controls disabled until client handlers can retain edits', () => {
  const root = document.createElement('div');
  root.innerHTML = renderToString(<DateFilter address={DEMO_ADDRESS} window={{}} mode={{kind:'live'}} source="transactions" />);
  expect(within(root).getByLabelText('From (UTC)')).toBeDisabled();
  expect(within(root).getByLabelText('To (UTC)')).toBeDisabled();
  expect(within(root).getByRole('button', {name:'Apply'})).toBeDisabled();
});
