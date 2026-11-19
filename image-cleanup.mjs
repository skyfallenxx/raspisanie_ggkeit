import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const converter = fileURLToPath(new URL('./image-input.ps1', import.meta.url));

function unpackBitmap(buffer) {
  if (buffer.length < 54 || buffer.toString('ascii', 0, 2) !== 'BM' ||
      buffer.readUInt16LE(28) !== 24 || buffer.readUInt32LE(30) !== 0) {
    throw new Error('Unsupported bitmap format');
  }
  const offset = buffer.readUInt32LE(10);
  const width = buffer.readInt32LE(18);
  const signedHeight = buffer.readInt32LE(22);
  const height = Math.abs(signedHeight);
  const stride = Math.ceil(width * 3 / 4) * 4;
  if (width <= 0 || height <= 0 || Math.max(width, height) > 4200 ||
      offset < 54 || offset + height * stride > buffer.length) {
    throw new Error('Invalid bitmap size');
  }
  const luminance = new Uint8Array(width * height);
  let total = 0;
  for (let y = 0; y < height; y++) {
    let position = offset + (signedHeight > 0 ? height - 1 - y : y) * stride;
    for (let x = 0; x < width; x++, position += 3) {
      const gray = Math.round(0.114 * buffer[position] + 0.587 * buffer[position + 1] + 0.299 * buffer[position + 2]);
      luminance[y * width + x] = gray;
      total += gray;
    }
  }
  if (total / luminance.length < 112) {
    for (let index = 0; index < luminance.length; index++) luminance[index] = 255 - luminance[index];
  }
  return { luminance, width, height };
}

function removeRules(luminance, width, height) {
  const rows = new Set();
  const columns = new Set();
  for (let y = 0; y < height; y++) {
    let dark = 0;
    for (let x = 0; x < width; x++) if (luminance[y * width + x] < 140) dark++;
    if (dark >= width * 0.77) rows.add(y);
  }
  const rules = [...rows].filter(y => !rows.has(y - 1));
  const groupEdges = new Set();
  const bodyEdges = new Set();
  for (let x = 0; x < width; x++) {
    let dark = 0;
    for (let y = 0; y < height; y++) if (luminance[y * width + x] < 140) dark++;
    if (dark >= height * 0.77) columns.add(x);
    if (rules.length === 7) {
      const [top, body] = rules;
      const bottom = rules.at(-1);
      let headerInk = 0;
      let bodyInk = 0;
      for (let y = top; y <= bottom; y++) {
        if (luminance[y * width + x] >= 155) continue;
        if (y < body) headerInk++;
        else bodyInk++;
      }
      if (bodyInk >= (bottom - body) * 0.68) {
        bodyEdges.add(x);
        columns.add(x);
        if (headerInk >= (body - top) * 0.85) groupEdges.add(x);
      }
    }
  }
  for (const y of rows) luminance.fill(255, y * width, (y + 1) * width);
  for (const x of columns) {
    for (let y = 0; y < height; y++) luminance[y * width + x] = 255;
  }
  const starts = set => [...set].filter(n => !set.has(n - 1));
  return { rules, groupEdges: starts(groupEdges), bodyEdges: starts(bodyEdges) };
}

function scaledPgm({ luminance, width, height }, geometry, weekly) {
  const scale = Math.min(3, 4700 / Math.max(width, height), Math.max(1, (weekly ? 4600 : 1100) / width));
  const border = 14;
  const contentWidth = Math.max(1, Math.round(width * scale));
  const contentHeight = Math.max(1, Math.round(height * scale));
  const outWidth = contentWidth + 2 * border;
  const outHeight = contentHeight + 2 * border;
  const pixels = Buffer.alloc(outWidth * outHeight, 255);
  for (let y = 0; y < contentHeight; y++) {
    const sy = Math.min(y / scale, height - 1);
    const y0 = Math.floor(sy);
    const y1 = Math.min(y0 + 1, height - 1);
    for (let x = 0; x < contentWidth; x++) {
      const sx = Math.min(x / scale, width - 1);
      const x0 = Math.floor(sx);
      const x1 = Math.min(x0 + 1, width - 1);
      const xWeight = sx - x0;
      const top = luminance[y0 * width + x0] * (1 - xWeight) + luminance[y0 * width + x1] * xWeight;
      const bottom = luminance[y1 * width + x0] * (1 - xWeight) + luminance[y1 * width + x1] * xWeight;
      pixels[(y + border) * outWidth + x + border] = Math.round(top + (bottom - top) * (sy - y0));
    }
  }
  return {
    image: Buffer.concat([Buffer.from(`P5\n${outWidth} ${outHeight}\n255\n`), pixels]),
    geometry: Object.fromEntries(Object.entries(geometry).map(([key, points]) =>
      [key, points.map(point => border + point * scale)])),
  };
}

export function rasterFormat(image) {
  if (image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (image.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return 'jpeg';
  if (image.toString('ascii', 0, 4) === 'RIFF' && image.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (image.toString('ascii', 0, 2) === 'BM') return 'bmp';
  const tiff = image.subarray(0, 4).toString('hex');
  if (tiff === '49492a00' || tiff === '4d4d002a') return 'tiff';
  return null;
}

export async function enhanceImage(input, bitmap, output, format, weekly = false) {
  const options = { timeout: 18_000, maxBuffer: 100_000, windowsHide: true };
  const limit = weekly ? 4200 : 2400;
  if (process.platform === 'win32') {
    const powershell = `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
    await run(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', converter, '-ImagePath', input, '-BitmapPath', bitmap, '-MaxDimension', String(limit)], options);
  } else {
    await run('magick', ['-limit', 'memory', '128MiB', '-limit', 'disk', '256MiB',
      `${format}:${input}[0]`, '-auto-orient', '-resize', `${limit}x${limit}>`,
      '-background', 'white', '-alpha', 'remove', '-alpha', 'off', '-type', 'TrueColor', `BMP3:${bitmap}`], options);
  }
  const image = unpackBitmap(await readFile(bitmap));
  const cleaned = scaledPgm(image, removeRules(image.luminance, image.width, image.height), weekly);
  await writeFile(output, cleaned.image);
  return cleaned.geometry;
}
