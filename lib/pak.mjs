// Reader for Chromium's DataPack ("resources.pak") container format.
//
// A .pak is a flat id -> blob store. There are no filenames anywhere in it;
// recovering those is the job of lib/extract.mjs.
//
// v4 layout (Chrome ~M14-M56, which covers the M40-era build we care about):
//   uint32 version | uint32 resource_count | uint8 encoding
//   (resource_count + 1) x { uint16 resource_id, uint32 offset }
//   ...blob bytes...
// The trailing entry is a sentinel: its offset is the end of the last blob,
// which is how each blob's length is derived.
//
// v5 layout (M57+) is handled too so the tool does not silently misread a
// newer snapshot someone points it at:
//   uint32 version | uint8 encoding + 3 pad | uint16 resource_count | uint16 alias_count
//   resource_count x { uint16 resource_id, uint32 offset } + sentinel
//   alias_count    x { uint16 resource_id, uint16 entry_index }

const ENCODINGS = { 0: "binary", 1: "utf8", 2: "utf16" };

export function parsePak(buf) {
  const version = buf.readUInt32LE(0);
  let count;
  let encoding;
  let entryStart;
  let aliasCount = 0;

  if (version === 4) {
    count = buf.readUInt32LE(4);
    encoding = buf.readUInt8(8);
    entryStart = 9;
  } else if (version === 5) {
    encoding = buf.readUInt8(4);
    count = buf.readUInt16LE(8);
    aliasCount = buf.readUInt16LE(10);
    entryStart = 12;
  } else {
    throw new Error(
      `unsupported .pak version ${version} (this tool handles v4 and v5)`,
    );
  }

  const need = entryStart + (count + 1) * 6;
  if (buf.length < need) {
    throw new Error(
      `truncated .pak: header declares ${count} entries but file is only ${buf.length} bytes`,
    );
  }

  const offsets = [];
  for (let i = 0; i <= count; i++) {
    const o = entryStart + i * 6;
    offsets.push({ id: buf.readUInt16LE(o), off: buf.readUInt32LE(o + 2) });
  }

  const entries = [];
  for (let i = 0; i < count; i++) {
    const start = offsets[i].off;
    const end = offsets[i + 1].off;
    if (end < start || end > buf.length) {
      throw new Error(
        `corrupt .pak: entry id=${offsets[i].id} has range ${start}..${end}`,
      );
    }
    entries.push({ id: offsets[i].id, bytes: buf.subarray(start, end) });
  }

  const aliases = [];
  if (aliasCount > 0) {
    const aliasStart = entryStart + (count + 1) * 6;
    for (let i = 0; i < aliasCount; i++) {
      const o = aliasStart + i * 4;
      const id = buf.readUInt16LE(o);
      const idx = buf.readUInt16LE(o + 2);
      if (entries[idx]) aliases.push({ id, bytes: entries[idx].bytes });
    }
  }

  return {
    version,
    encoding: ENCODINGS[encoding] ?? `unknown(${encoding})`,
    entries: entries.concat(aliases),
  };
}
