/**
 * Minimal remote ZIP member fetcher: pulls only the requested members of a
 * (possibly huge) ZIP archive served over HTTP, using Range requests --
 * without downloading the whole archive. Node stdlib only (zlib, fetch).
 *
 * Why this exists: GuitarSet's audio archives on Zenodo
 * (https://zenodo.org/records/3371780) are hundreds of MB to several GB
 * each, but this spike only needs 12 of the 360 member files. Zenodo's
 * download endpoint honors HTTP Range on the underlying file (verified: a
 * `Range: bytes=0-1000` request against audio_mono-mic.zip returns
 * `206 Partial Content` / `Content-Range: bytes 0-1000/656927981`), so we
 * can read just the ZIP End-Of-Central-Directory + Central Directory records
 * to locate each target member, then Range-fetch only that member's bytes.
 */
import zlib from 'node:zlib';

const EOCD_SIG = 0x06054b50;
const CDIR_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const EOCD_MIN_SIZE = 22;
const EOCD_SEARCH_WINDOW = 65557; // max comment length (65535) + EOCD record size

export class RemoteZip {
  constructor(url) {
    this.url = url;
    this.bytesFetched = 0;
    this.requestCount = 0;
  }

  async _rangeGet(start, end) {
    const res = await fetch(this.url, {
      headers: { Range: `bytes=${start}-${end}` },
    });
    if (res.status !== 206 && res.status !== 200) {
      throw new Error(`Range request failed: HTTP ${res.status} for ${this.url}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    this.bytesFetched += buf.length;
    this.requestCount += 1;
    return buf;
  }

  async _length() {
    if (this._len) return this._len;
    const res = await fetch(this.url, { method: 'HEAD' });
    this._len = Number(res.headers.get('content-length'));
    return this._len;
  }

  async _loadCentralDirectory() {
    if (this._entries) return this._entries;
    const length = await this._length();
    const tailStart = Math.max(0, length - EOCD_SEARCH_WINDOW);
    const tail = await this._rangeGet(tailStart, length - 1);

    let eocdOffset = -1;
    for (let i = tail.length - EOCD_MIN_SIZE; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD_SIG) {
        eocdOffset = i;
        break;
      }
    }
    if (eocdOffset === -1) {
      throw new Error('Could not locate ZIP End Of Central Directory record');
    }

    const entryCount = tail.readUInt16LE(eocdOffset + 10);
    const cdirSize = tail.readUInt32LE(eocdOffset + 12);
    const cdirOffset = tail.readUInt32LE(eocdOffset + 16);

    let cdirBuf;
    const tailCoversCdir = cdirOffset >= tailStart;
    if (tailCoversCdir) {
      cdirBuf = tail.subarray(cdirOffset - tailStart, eocdOffset);
    } else {
      cdirBuf = await this._rangeGet(cdirOffset, cdirOffset + cdirSize - 1);
    }

    const entries = new Map();
    let p = 0;
    for (let i = 0; i < entryCount; i++) {
      if (cdirBuf.readUInt32LE(p) !== CDIR_SIG) {
        throw new Error(`Bad central directory entry signature at index ${i}`);
      }
      const compMethod = cdirBuf.readUInt16LE(p + 10);
      const compSize = cdirBuf.readUInt32LE(p + 20);
      const uncompSize = cdirBuf.readUInt32LE(p + 24);
      const nameLen = cdirBuf.readUInt16LE(p + 28);
      const extraLen = cdirBuf.readUInt16LE(p + 30);
      const commentLen = cdirBuf.readUInt16LE(p + 32);
      const localHeaderOffset = cdirBuf.readUInt32LE(p + 42);
      const name = cdirBuf.toString('utf8', p + 46, p + 46 + nameLen);
      entries.set(name, { compMethod, compSize, uncompSize, localHeaderOffset });
      p += 46 + nameLen + extraLen + commentLen;
    }
    this._entries = entries;
    return entries;
  }

  async listNames() {
    const entries = await this._loadCentralDirectory();
    return [...entries.keys()];
  }

  async readMember(name) {
    const entries = await this._loadCentralDirectory();
    const entry = entries.get(name);
    if (!entry) throw new Error(`Member not found in archive: ${name}`);

    // Local header has variable-length name/extra fields that can differ
    // from the central directory copy, so read it first to find the true
    // data start offset instead of trusting a fixed 30-byte header size.
    const headerProbe = await this._rangeGet(
      entry.localHeaderOffset,
      entry.localHeaderOffset + 30 - 1,
    );
    if (headerProbe.readUInt32LE(0) !== LOCAL_SIG) {
      throw new Error(`Bad local file header signature for ${name}`);
    }
    const nameLen = headerProbe.readUInt16LE(26);
    const extraLen = headerProbe.readUInt16LE(28);
    const dataStart = entry.localHeaderOffset + 30 + nameLen + extraLen;
    const dataEnd = dataStart + entry.compSize - 1;

    const compressed = await this._rangeGet(dataStart, dataEnd);
    if (entry.compMethod === 0) return compressed; // stored, no compression
    if (entry.compMethod === 8) return zlib.inflateRawSync(compressed); // deflate
    throw new Error(`Unsupported ZIP compression method ${entry.compMethod} for ${name}`);
  }
}
