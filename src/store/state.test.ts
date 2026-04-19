import { describe, expect, it } from 'vitest'
import { Signal } from './state'

describe('Signal', () => {
  it('exposes the initial value', () => {
    const s = new Signal(42)
    expect(s.value).toBe(42)
  })

  it('set() updates the value and notifies subscribers', () => {
    const s = new Signal('a')
    const seen: string[] = []
    s.subscribe((v) => seen.push(v))
    s.set('b')
    s.set('c')
    expect(s.value).toBe('c')
    expect(seen).toEqual(['b', 'c'])
  })

  it('subscribe() does not fire for the initial value', () => {
    const s = new Signal(1)
    const seen: number[] = []
    s.subscribe((v) => seen.push(v))
    expect(seen).toEqual([])
  })

  it('unsubscribe stops future notifications', () => {
    const s = new Signal(0)
    const seen: number[] = []
    const off = s.subscribe((v) => seen.push(v))
    s.set(1)
    off()
    s.set(2)
    expect(seen).toEqual([1])
  })

  it('multiple subscribers all receive updates', () => {
    const s = new Signal(0)
    const a: number[] = []
    const b: number[] = []
    s.subscribe((v) => a.push(v))
    s.subscribe((v) => b.push(v))
    s.set(5)
    expect(a).toEqual([5])
    expect(b).toEqual([5])
  })
})
