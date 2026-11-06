const fs = require('node:fs/promises');
const path = require('node:path');
const { createReadStream } = require('node:fs');

const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (0xedb88320 & -(value & 1));
  return value >>> 0;
});

// PNGs are already compressed. Store them directly in a standard UTF-8 ZIP.
function crc32(data, previous = 0) {
  let crc = (previous ^ 0xffffffff) >>> 0;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function buildZip(entries) {
  const files = [];
  const directory = [];
  let offset = 0;
  for (const entry of entries) {
    if (!entry.name || /(^|\/)\.\.(\/|$)|^\/|\\/.test(entry.name)) throw new Error('无效的压缩包路径');
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(33, 12); // 1980-01-01; capture times live in manifest.json.
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    files.push(local, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(33, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    directory.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const size = directory.reduce((sum, buffer) => sum + buffer.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(size, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...files, ...directory, end]);
}

async function writeZip(entries, outputPath) {
  const temporary = `${outputPath}.tmp`;
  const output = await fs.open(temporary, 'w');
  const directory = [];
  let offset = 0;
  async function write(data) {
    if (offset + data.length > 0xffffffff) throw new Error('快照包超过 4GB，请拆分批次下载');
    let written = 0;
    while (written < data.length) {
      const result = await output.write(data, written, data.length - written);
      written += result.bytesWritten;
      offset += result.bytesWritten;
    }
  }
  try {
    for (const entry of entries) {
      if (!entry.name || /(^|\/)\.\.(\/|$)|^\/|\\/.test(entry.name)) throw new Error('无效的压缩包路径');
      const name = Buffer.from(entry.name);
      const start = offset;
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(0x0808, 6); // UTF-8 + checksum/size in a trailing descriptor.
      local.writeUInt16LE(33, 12);
      local.writeUInt16LE(name.length, 26);
      await write(local); await write(name);
      let checksum = 0;
      let size = 0;
      const chunks = entry.filePath ? createReadStream(entry.filePath) : [Buffer.from(entry.data)];
      for await (const chunk of chunks) {
        checksum = crc32(chunk, checksum);
        size += chunk.length;
        await write(chunk);
      }
      const descriptor = Buffer.alloc(16);
      descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(checksum, 4);
      descriptor.writeUInt32LE(size, 8);
      descriptor.writeUInt32LE(size, 12);
      await write(descriptor);
      const central = Buffer.alloc(46);
      central.writeUInt32LE(0x02014b50, 0);
      central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
      central.writeUInt16LE(0x0808, 8); central.writeUInt16LE(33, 14);
      central.writeUInt32LE(checksum, 16);
      central.writeUInt32LE(size, 20); central.writeUInt32LE(size, 24);
      central.writeUInt16LE(name.length, 28); central.writeUInt32LE(start, 42);
      directory.push(central, name);
    }
    const start = offset;
    for (const item of directory) await write(item);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(offset - start, 12); end.writeUInt32LE(start, 16);
    await write(end);
  } catch (error) {
    await output.close(); await fs.rm(temporary, { force: true }); throw error;
  }
  await output.close();
  await fs.rename(temporary, outputPath);
}

async function writeSnapshotArchive(report, runDir) {
  const entries = [];
  const snapshots = [];
  for (let index = 0; index < report.results.length; index++) {
    const result = report.results[index];
    let filename = null;
    if (result.snapshotSaved) {
      const host = new URL(result.submittedUrl).hostname.replace(/[^a-z0-9.-]/gi, '_');
      filename = `${String(index + 1).padStart(3, '0')}-${host}${result.sourceType === 'x' ? '-post' : ''}.png`;
      entries.push({ name: filename, filePath: path.join(runDir, String(index + 1).padStart(3, '0'), result.sourceType === 'x' ? 'post.png' : 'page.png') });
    }
    snapshots.push({ url: result.submittedUrl, finalUrl: result.finalUrl || null, title: result.title || null,
      capturedAt: result.capturedAt || null, status: result.snapshotSaved ? 'captured' : 'failed',
      filename, error: result.snapshotSaved ? null : result.reason, cached: result.cached,
      captureScope: result.captureScope, dimensions: result.dimensions, truncated: result.truncated || false, warnings: result.warnings || [] });
  }
  entries.push({ name: 'manifest.json', data: JSON.stringify({ createdAt: report.createdAt, snapshots }, null, 2) });
  await writeZip(entries, path.join(runDir, 'snapshots.zip'));
}

module.exports = { buildZip, crc32, writeZip, writeSnapshotArchive };
