// Minimal WOFF 1.0 → TTF/OTF converter. @fontsource ships only woff/woff2,
// and @resvg/resvg-js (used by build-og.mjs) only loads sfnt fonts. WOFF1 is
// just an sfnt with per-table zlib compression, so unpacking it needs nothing
// beyond node:zlib. WOFF2 is not handled (Brotli + table transforms).

import { inflateSync } from 'node:zlib'

export function woffToTtf(woff) {
  const buf = Buffer.from(woff)
  if (buf.toString('latin1', 0, 4) !== 'wOFF') throw new Error('not a WOFF 1.0 file')
  const flavor = buf.readUInt32BE(4)
  const numTables = buf.readUInt16BE(12)

  const tables = []
  for (let i = 0; i < numTables; i++) {
    const o = 44 + i * 20
    const tag = buf.subarray(o, o + 4)
    const offset = buf.readUInt32BE(o + 4)
    const compLength = buf.readUInt32BE(o + 8)
    const origLength = buf.readUInt32BE(o + 12)
    const checksum = buf.readUInt32BE(o + 16)
    const raw = buf.subarray(offset, offset + compLength)
    const data = compLength < origLength ? inflateSync(raw) : Buffer.from(raw)
    tables.push({ tag, checksum, data })
  }

  const pad4 = (n) => (n + 3) & ~3
  const dirSize = 12 + numTables * 16
  let total = dirSize
  for (const t of tables) total += pad4(t.data.length)
  const out = Buffer.alloc(total)

  let entrySelector = 0
  while (1 << (entrySelector + 1) <= numTables) entrySelector++
  const searchRange = (1 << entrySelector) * 16
  out.writeUInt32BE(flavor, 0)
  out.writeUInt16BE(numTables, 4)
  out.writeUInt16BE(searchRange, 6)
  out.writeUInt16BE(entrySelector, 8)
  out.writeUInt16BE(numTables * 16 - searchRange, 10)

  let dataOffset = dirSize
  tables.forEach((t, i) => {
    const rec = 12 + i * 16
    t.tag.copy(out, rec)
    out.writeUInt32BE(t.checksum, rec + 4)
    out.writeUInt32BE(dataOffset, rec + 8)
    out.writeUInt32BE(t.data.length, rec + 12)
    t.data.copy(out, dataOffset)
    dataOffset += pad4(t.data.length)
  })
  return out
}
