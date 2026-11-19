import {Buffer} from 'node:buffer'
import {crc32, deflateRawSync} from 'node:zlib'

/** Single-entry Actions-style ZIP, with an actual raw DEFLATE payload. */
export function releaseZip(name: string, text: string): Buffer {
  const filename = Buffer.from(name)
  const plain = Buffer.from(text)
  const data = deflateRawSync(plain)
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034B50)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(8, 8)
  local.writeUInt32LE(crc32(plain), 14)
  local.writeUInt32LE(data.length, 18)
  local.writeUInt32LE(plain.length, 22)
  local.writeUInt16LE(filename.length, 26)
  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014B50)
  central.writeUInt16LE(20, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt16LE(8, 10)
  central.writeUInt32LE(crc32(plain), 16)
  central.writeUInt32LE(data.length, 20)
  central.writeUInt32LE(plain.length, 24)
  central.writeUInt16LE(filename.length, 28)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054B50)
  end.writeUInt16LE(1, 8)
  end.writeUInt16LE(1, 10)
  end.writeUInt32LE(central.length + filename.length, 12)
  end.writeUInt32LE(local.length + filename.length + data.length, 16)
  return Buffer.concat([local, filename, data, central, filename, end])
}
