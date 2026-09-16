import { fireEvent, screen } from '@testing-library/react'
import { renderWithProviders } from './helpers'
import JobForm from '../components/JobForm'

vi.mock('../api/client', () => ({
  api: {
    models: vi.fn().mockResolvedValue([]),
    createCron: vi.fn().mockResolvedValue({ ok: true }),
    updateCron: vi.fn().mockResolvedValue({ ok: true }),
  },
}))

describe('JobForm Run once strict default', () => {
  it('enables Strict schedule when a new job selects Run once', async () => {
    renderWithProviders(
      <JobForm agents={[]} defaultAgent="" onSaved={vi.fn()} layout="vertical" />,
    )

    fireEvent.click(screen.getByRole('combobox', { name: 'Schedule' }))
    fireEvent.click(await screen.findByRole('option', { name: 'Run once' }))

    expect(screen.getByRole('switch', { name: 'Strict schedule' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
  })
})
