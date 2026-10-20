import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '@/lib/types'
import { saveStrategyConfig } from '@/lib/strategyConfig'
import { StrategyConfig } from '../strategy-config'

vi.mock('@/lib/strategyConfig', () => ({
  saveStrategyConfig: vi.fn(),
}))

function renderConfig(
  overrides: Partial<typeof DEFAULT_CONFIG> = {},
  onSave = vi.fn(),
) {
  const config = { ...DEFAULT_CONFIG, ...overrides }
  const view = render(<StrategyConfig config={config} onSave={onSave} />)
  return { ...view, onSave, config }
}

describe('StrategyConfig multi-timeframe filter', () => {
  it('enables the filter when the persisted config predates the toggle', () => {
    renderConfig({ useMultiTimeframe: undefined })

    expect(
      screen.getByRole('switch', { name: /multi-timeframe confluence/i }),
    ).toHaveAttribute('aria-checked', 'true')
    expect(
      screen.getByText(/On — counter-trend entries are vetoed/),
    ).toBeInTheDocument()
  })

  it('saves an explicit opt-out', () => {
    const { onSave } = renderConfig({ useMultiTimeframe: true })

    fireEvent.click(
      screen.getByRole('switch', { name: /multi-timeframe confluence/i }),
    )
    expect(
      screen.getByRole('switch', { name: /multi-timeframe confluence/i }),
    ).toHaveAttribute('aria-checked', 'false')

    fireEvent.click(screen.getByRole('button', { name: /save config/i }))

    expect(vi.mocked(saveStrategyConfig)).toHaveBeenCalledWith(
      expect.objectContaining({ useMultiTimeframe: false }),
    )
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ useMultiTimeframe: false }),
    )
  })

  it('adopts config that arrives after mount (daemon status)', () => {
    const { rerender, onSave } = renderConfig({ useMultiTimeframe: true })

    rerender(
      <StrategyConfig
        config={{ ...DEFAULT_CONFIG, useMultiTimeframe: false }}
        onSave={onSave}
      />,
    )

    expect(
      screen.getByRole('switch', { name: /multi-timeframe confluence/i }),
    ).toHaveAttribute('aria-checked', 'false')
  })

  it('keeps unsaved edits across status polls with unchanged config', () => {
    const { rerender, onSave } = renderConfig({ useMultiTimeframe: true })

    fireEvent.click(
      screen.getByRole('switch', { name: /multi-timeframe confluence/i }),
    )
    rerender(
      <StrategyConfig
        config={{ ...DEFAULT_CONFIG, useMultiTimeframe: true }}
        onSave={onSave}
      />,
    )

    expect(
      screen.getByRole('switch', { name: /multi-timeframe confluence/i }),
    ).toHaveAttribute('aria-checked', 'false')
  })
})
