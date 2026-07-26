import { createUniqueId, Show } from 'solid-js'
import type { VisualizationMode } from '../guitar/types'
import { t } from '../i18n'

export interface VisualizationSelectorProps {
  mode: VisualizationMode
  onChange: (mode: VisualizationMode) => void
  disabled: boolean
  disabledReason?: string | undefined
}

const MODES: readonly VisualizationMode[] = ['piano', 'guitar']

export function VisualizationSelector(props: VisualizationSelectorProps) {
  const reasonId = `visualization-disabled-${createUniqueId()}`
  const groupName = `visualization-${createUniqueId()}`
  const disabledReason = (): string | undefined =>
    props.disabled ? (props.disabledReason ?? t('visualization.learnPianoRequired')) : undefined

  const select = (mode: VisualizationMode): void => {
    if (!props.disabled && mode !== props.mode) props.onChange(mode)
  }

  return (
    <div class="ts-visualization-selector">
      <div
        class="ts-view-switch"
        classList={{ 'is-disabled': props.disabled }}
        role="radiogroup"
        aria-label={t('visualization.aria')}
        aria-describedby={disabledReason() ? reasonId : undefined}
      >
        {MODES.map((mode) => (
          <label
            class="ts-view-option"
            classList={{ 'is-active': props.mode === mode }}
            title={t(`visualization.${mode}.aria`)}
          >
            <input
              class="ts-view-input"
              type="radio"
              name={groupName}
              value={mode}
              checked={props.mode === mode}
              disabled={props.disabled}
              aria-label={t(`visualization.${mode}.aria`)}
              onChange={() => select(mode)}
            />
            <span aria-hidden="true" class={`ts-view-glyph ts-view-glyph--${mode}`} />
            <span class="ts-view-label">{t(`visualization.${mode}.label`)}</span>
          </label>
        ))}
      </div>
      <Show when={disabledReason()}>
        {(reason) => (
          <span class="ts-view-disabled-reason" id={reasonId}>
            {reason()}
          </span>
        )}
      </Show>
    </div>
  )
}
