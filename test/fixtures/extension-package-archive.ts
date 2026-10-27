import { crc32, deflateRawSync } from "node:zlib";

/** Synthetic ZIP bytes, never used by the production installer. */
export function packageArchive(
  entries: {
    name: string;
    data?: string | Buffer;
    mode?: number;
    compressed?: boolean;
    declaredSize?: number;
    crc?: number;
  }[],
): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const data = Buffer.from(entry.data ?? "");
    const bytes = entry.compressed ? deflateRawSync(data) : data;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(entry.compressed ? 8 : 0, 8);
    header.writeUInt32LE(entry.crc ?? crc32(data), 14);
    header.writeUInt32LE(bytes.length, 18);
    header.writeUInt32LE(entry.declaredSize ?? data.length, 22);
    header.writeUInt16LE(name.length, 26);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(0x0314, 4);
    header.copy(directory, 6, 4, 28);
    directory.writeUInt32LE(
      ((entry.mode ?? (entry.name.endsWith("/") ? 0o040700 : 0o100600)) <<
        16) >>>
        0,
      38,
    );
    directory.writeUInt32LE(offset, 42);
    local.push(header, name, bytes);
    central.push(directory, name);
    offset += header.length + name.length + bytes.length;
  }
  const table = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(table.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, table, end]);
}
