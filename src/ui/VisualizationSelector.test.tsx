import { fireEvent, render, screen } from '@solidjs/testing-library'
import { createSignal } from 'solid-js'
import { describe, expect, it, vi } from 'vitest'
import { type Messages, setLocale } from '../i18n'
import { en } from '../i18n/locales/en'
import es from '../i18n/locales/es'
import fr from '../i18n/locales/fr'
import pl from '../i18n/locales/pl'
import ptBR from '../i18n/locales/pt-BR'
import zhCN from '../i18n/locales/zh-CN'
import { VisualizationSelector } from './VisualizationSelector'

describe('VisualizationSelector', () => {
  it('shows distinct piano and guitar choices and reports selection changes', () => {
    const onChange = vi.fn()
    render(() => <VisualizationSelector mode="piano" onChange={onChange} disabled={false} />)

    expect(screen.getByRole('radiogroup', { name: en['visualization.aria'] })).toBeTruthy()
    const piano = screen.getByRole('radio', {
      name: en['visualization.piano.aria'],
    }) as HTMLInputElement
    expect(piano.checked).toBe(true)
    fireEvent.change(piano)
    expect(onChange).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('radio', { name: en['visualization.guitar.aria'] }))
    expect(onChange).toHaveBeenCalledWith('guitar')
  })

  it('uses one native radio group for browser keyboard navigation', () => {
    render(() => <VisualizationSelector mode="piano" onChange={vi.fn()} disabled={false} />)
    const piano = screen.getByRole('radio', { name: en['visualization.piano.aria'] })
    const guitar = screen.getByRole('radio', { name: en['visualization.guitar.aria'] })

    expect(piano.tagName).toBe('INPUT')
    expect(piano.getAttribute('type')).toBe('radio')
    expect(guitar.getAttribute('name')).toBe(piano.getAttribute('name'))
  })

  it('disables both choices and exposes the piano-only Learn explanation', () => {
    const onChange = vi.fn()
    const reason = en['visualization.learnPianoRequired']
    render(() => (
      <VisualizationSelector
        mode="piano"
        onChange={onChange}
        disabled={true}
        disabledReason={reason}
      />
    ))

    const group = screen.getByRole('radiogroup', { name: en['visualization.aria'] })
    const explanation = screen.getByText(reason)
    expect(explanation.textContent).toBe(reason)
    expect(explanation.getAttribute('role')).toBeNull()
    expect(group.getAttribute('aria-describedby')).toBe(explanation.id)
    for (const choice of screen.getAllByRole('radio')) {
      expect((choice as HTMLInputElement).disabled).toBe(true)
    }
    fireEvent.click(screen.getByRole('radio', { name: en['visualization.guitar.aria'] }))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('reacts to disabled state, reason, and locale changes without duplicating the reason', async () => {
    const [disabled, setDisabled] = createSignal(false)
    const [reason, setReason] = createSignal<string>()
    render(() => (
      <VisualizationSelector
        mode="piano"
        onChange={vi.fn()}
        disabled={disabled()}
        disabledReason={reason()}
      />
    ))

    const group = screen.getByRole('radiogroup', { name: en['visualization.aria'] })
    expect(group.getAttribute('aria-describedby')).toBeNull()

    setDisabled(true)
    expect(screen.getAllByText(en['visualization.learnPianoRequired'])).toHaveLength(1)

    setReason('Custom reason')
    expect(screen.queryByText(en['visualization.learnPianoRequired'])).toBeNull()
    expect(screen.getAllByText('Custom reason')).toHaveLength(1)

    setReason(undefined)
    await setLocale('pl')
    expect(screen.getByRole('radio', { name: pl['visualization.piano.aria'] })).toBeTruthy()
    expect(screen.getByText(pl['visualization.piano.label'])).toBeTruthy()
    expect(screen.getAllByText(pl['visualization.learnPianoRequired'])).toHaveLength(1)
    await setLocale('en')
  })

  it('ships matching visualization and guitar-renderer keys in every locale', () => {
    const locales: readonly Messages[] = [es, fr, pl, ptBR, zhCN]
    const keys = Object.keys(en).filter(
      (key) => key.startsWith('visualization.') || key.startsWith('guitar.'),
    )

    expect(keys.length).toBeGreaterThan(0)
    for (const messages of locales) {
      expect(keys.filter((key) => !(key in messages))).toEqual([])
    }
  })
})
