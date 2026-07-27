// Minimal zip reader.
//
// Node has no built-in zip support, and shelling out is not portable: `unzip`
// is absent on stock Windows, `Expand-Archive` is absent on Linux/macOS. Since
// the whole point of this tool is to run identically on all three, the ~100
// lines of central-directory parsing below are cheaper than a dependency.
//
// Deliberately not supported: ZIP64, encryption, compression methods other
// than store/deflate. Chromium snapshot zips need none of them (the archive is
// well under 4 GiB and every entry is stored or deflated).

import { inflateRawSync } from "node:zlib";

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;

function findEocd(buf) {
  // The EOCD sits at the end, but a trailing comment can push it back by up to
  // 64 KiB, so scan backwards over that window.
  const min = Math.max(0, buf.length - 0x10000 - 22);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw new Error("not a zip file: no end-of-central-directory record found");
}

export function readZipIndex(buf) {
  const eocd = findEocd(buf);
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);

  if (cdOffset === 0xffffffff || count === 0xffff) {
    throw new Error("ZIP64 archives are not supported by this reader");
  }

  const files = new Map();
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== CD_SIG) {
      throw new Error(`corrupt central directory at entry ${i}`);
    }
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const uncompressedSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);

    if (!name.endsWith("/")) {
      files.set(name, { method, compressedSize, uncompressedSize, localOffset });
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

export function readZipEntry(buf, entry) {
  const { localOffset, method, compressedSize, uncompressedSize } = entry;
  if (buf.readUInt32LE(localOffset) !== LFH_SIG) {
    throw new Error("corrupt zip: bad local file header signature");
  }
  // The local header repeats the name/extra lengths, and they can differ from
  // the central directory's, so read them from here rather than reusing.
  const nameLen = buf.readUInt16LE(localOffset + 26);
  const extraLen = buf.readUInt16LE(localOffset + 28);
  const start = localOffset + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + compressedSize);

  if (method === 0) return Buffer.from(raw);
  if (method === 8) {
    const out = inflateRawSync(raw);
    if (out.length !== uncompressedSize) {
      throw new Error(
        `zip entry inflated to ${out.length} bytes, expected ${uncompressedSize}`,
      );
    }
    return out;
  }
  throw new Error(`unsupported zip compression method ${method}`);
}
