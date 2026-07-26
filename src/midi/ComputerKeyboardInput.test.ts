import { afterEach, describe, expect, it } from 'vitest'
import type { MasterClock } from '../core/clock/MasterClock'
import { ComputerKeyboardInput } from './ComputerKeyboardInput'

describe('ComputerKeyboardInput voice identity', () => {
  let input: ComputerKeyboardInput | undefined

  afterEach(() => input?.dispose())

  it('uses a stable source and preserves a generated voice ID through key release', () => {
    input = new ComputerKeyboardInput({ currentTime: 4 } as MasterClock)
    const ons: NonNullable<(typeof input.noteOn)['value']>[] = []
    const offs: NonNullable<(typeof input.noteOff)['value']>[] = []
    input.noteOn.subscribe((event) => event && ons.push(event))
    input.noteOff.subscribe((event) => event && offs.push(event))
    input.enable()

    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyZ' }))
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyZ' }))

    expect(ons[0]).toMatchObject({ pitch: 60, sourceId: 'computer-keyboard' })
    expect(offs[0]).toMatchObject({ pitch: 60, sourceId: 'computer-keyboard' })
    expect(offs[0]!.voiceId).toBe(ons[0]!.voiceId)
  })
})
