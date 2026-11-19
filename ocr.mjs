import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { dayIndex, formatWeek, InputError, lessonEntries, lessonLine, normalizeGroup, parseBase, parseChangesMessage } from './schedule.mjs';
import { enhanceImage, rasterFormat } from './image-cleanup.mjs';
import { findGroupBlock, formatGroupBlock, numberStrip } from './group-layout.mjs';
import { weeklyGroupsFromRows } from './weekly-sheet.mjs';

const run = promisify(execFile);

function cropPgm(image, rectangle) {
  const header = /^P5\n(\d+) (\d+)\n255\n/u.exec(image.toString('ascii', 0, 64));
  const width = Number(header[1]);
  const body = image.subarray(header[0].length);
  const [left, top, right, bottom] = rectangle.map(Math.round);
  const pixels = [];
  for (let y = top; y < bottom; y++) pixels.push(body.subarray(y * width + left, y * width + right));
  return Buffer.concat([Buffer.from(`P5\n${right - left} ${bottom - top}\n255\n`), ...pixels]);
}

async function executable() {
  if (process.env.TESSERACT_PATH) return process.env.TESSERACT_PATH;
  if (process.platform === 'win32') {
    const installedPath = join(process.env.ProgramFiles || 'C:\\Program Files', 'Tesseract-OCR', 'tesseract.exe');
    try {
      await access(installedPath);
      return installedPath;
    } catch {
      // Also support installations already in PATH.
    }
  }
  return 'tesseract';
}

function readWords(tsv) {
  return tsv.split(/\r?\n/u).slice(1).flatMap(line => {
    const fields = line.split('\t');
    const word = fields.slice(11).join('\t').trim();
    if (fields[0] !== '5' || !word) return [];
    const [left, top, width, height] = fields.slice(6, 10).map(Number);
    return [{ text: word, x: left + width / 2, y: top + height / 2, left, right: left + width, height, confidence: Number(fields[10]) }];
  });
}

function groupRows(words) {
  const rows = [];
  for (const word of [...words].sort((a, b) => a.y - b.y)) {
    const last = rows.at(-1);
    if (last && word.y - last.y <= Math.max(last.height, word.height) * 0.6) {
      last.words.push(word);
    } else {
      rows.push({ y: word.y, height: word.height, words: [word] });
    }
  }
  for (const row of rows) row.words.sort((a, b) => a.left - b.left);
  return rows;
}

function tableWeek(rows) {
  const headerIndex = rows.findIndex(row => new Set(row.words.map(word => dayIndex(word.text)).filter(day => day >= 0)).size >= 2);
  if (headerIndex < 0) return null;
  const headers = rows[headerIndex].words
    .map(word => ({ ...word, day: dayIndex(word.text) })).filter(word => word.day >= 0);
  if (new Set(headers.map(header => header.day)).size !== headers.length) return null;
  const week = Object.fromEntries(headers.map(header => [header.day, {}]));
  let number = 0;
  for (const row of rows.slice(headerIndex + 1)) {
    if (row.words.some(word => dayIndex(word.text) >= 0)) break;
    const cells = headers.map(() => []);
    const marker = row.words.find(word => /^\d{1,2}[.)]?$/u.test(word.text) &&
      word.x < headers[0].x - (headers[1].x - headers[0].x) / 2);
    for (const word of row.words) {
      if (word === marker) continue;
      const column = headers.reduce((closest, header, index) =>
        Math.abs(header.x - word.x) < Math.abs(headers[closest].x - word.x) ? index : closest, 0);
      cells[column].push(word.text);
    }
    if (!cells.some(cell => cell.length)) continue;
    number = marker ? parseInt(marker.text, 10) : number + 1;
    if (number > 20) break;
    for (const [index, cell] of cells.entries()) {
      const value = cell.join(' ');
      if (!value || /^[-—–]+$/u.test(value)) continue;
      const lesson = lessonLine(value);
      const lessons = week[headers[index].day];
      if (lesson) lessons[lesson[0]] ??= lesson[1];
      else lessons[number] ??= value;
    }
  }
  return Object.values(week).some(entries => Object.keys(entries).length) ? week : null;
}

export function parseTsv(tsv, week, rules) {
  const words = readWords(tsv);
  const rows = groupRows(words);
  return {
    table: week ? tableWeek(rows) : null,
    sheet: week ? weeklyGroupsFromRows(rows, rules) : null,
    raw: rows.map(row => row.words.map(word => word.text).join(' ')).join('\n'),
    confidence: words.reduce((total, word) => total + word.confidence, 0) / Math.max(1, words.length),
  };
}

function resultScore(result, { week, key, now }) {
  let valid = false;
  try {
    if (week) parseBase(result.table ? formatWeek(result.table) : result.raw);
    else parseChangesMessage(result.raw, key, now);
    valid = true;
  } catch {
    // Partial recognition can still be shown for manual correction.
  }
  const lines = result.raw.split('\n');
  const numbered = lines.filter(line => lessonEntries(line).length && /\p{L}/u.test(line)).length;
  const cyrillic = result.raw.match(/\p{Script=Cyrillic}/gu)?.length || 0;
  return (valid ? 10_000 : 0) + numbered * 4 + Math.min(cyrillic / 10, 70) + result.confidence / 3;
}

export async function recognize(image, { week, key, now, group, subgroup } = {}) {
  const format = rasterFormat(image);
  if (!format) throw new Error('Не удалось открыть снимок. Пришлите изображение в формате JPEG или PNG.');
  const command = await executable();
  const directory = await mkdtemp(join(tmpdir(), 'schedule-ocr-'));
  const path = join(directory, `timetable.${format}`);
  const bitmap = join(directory, 'decoded.bmp');
  const cleaned = join(directory, 'cleaned.pgm');
  const numbersPath = join(directory, 'numbers.pgm');
  const cropPath = join(directory, 'column.pgm');
  try {
    await writeFile(path, image);
    const languages = process.env.OCR_LANG || 'rus+eng';
    const scan = async (file, mode, language = languages, config = []) => {
      const dpi = file === cleaned || file === numbersPath || file === cropPath ? ['--dpi', '300'] : [];
      const { stdout } = await run(command, [file, 'stdout', '-l', language, '--psm', mode, ...dpi, ...config, 'tsv'], {
        timeout: week ? 65_000 : 18_000, maxBuffer: week ? 12_000_000 : 2_000_000, windowsHide: true,
      });
      return stdout;
    };
    const rules = await enhanceImage(path, bitmap, cleaned, format, week).catch(() => null);
    const enhanced = Boolean(rules);
    if (week && rules?.rules.length === 7 && rules.groupEdges.length >= 4) {
      const image = await readFile(cleaned);
      const [top, body] = rules.rules.map(Math.round);
      const edges = rules.groupEdges.map(Math.round);
      const bottom = Math.round(rules.rules.at(-1));
      const left = edges[0];
      const right = edges.at(-1);
      await writeFile(cropPath, cropPgm(image, [left, top, right, body]));
      const names = readWords(await scan(cropPath, '7')).map(word => ({
        ...word, x: word.x + left, y: word.y + top, left: word.left + left, right: word.right + left,
      })).filter(word => normalizeGroup(word.text));
      for (let index = 0; index + 1 < edges.length; index++) {
        const start = edges[index];
        const end = edges[index + 1];
        if (end - start < 60 || names.some(word => word.x > start && word.x < end)) continue;
        await writeFile(cropPath, cropPgm(image, [start, top, end, body]));
        const words = readWords(await scan(cropPath, '7'));
        const text = words.map(word => word.text).join('');
        if (normalizeGroup(text)) names.push({ text, x: (start + end) / 2 });
      }
      if (names.length) {
        const header = { words: names.sort((a, b) => a.x - b.x), y: top + (body - top) / 2, height: (body - top) / 2 };
        const recognized = weeklyGroupsFromRows([header], rules);
        if (recognized && Object.keys(recognized.headers).length >= 2) {
          for (let index = 0; index + 1 < edges.length; index++) {
            const start = edges[index];
            const end = edges[index + 1];
            if (!header.words.some(word => word.x > start && word.x < end)) continue;
            await writeFile(cropPath, cropPgm(image, [start, body, end, bottom]));
            const words = readWords(await scan(cropPath, '6')).map(word => ({
              ...word, x: word.x + start, y: word.y + body, left: word.left + start, right: word.right + start,
            }));
            const sheet = weeklyGroupsFromRows([header, ...groupRows(words)], rules);
            if (sheet) Object.assign(recognized.groups, sheet.groups);
          }
          return { raw: '', table: null, sheet: recognized };
        }
      }
    }
    const perform = async (file, mode) => parseTsv(await scan(file, mode), week, file === cleaned ? rules : undefined);
    const options = { week, key, now };
    const primary = await scan(enhanced ? cleaned : path, week ? '11' : '6');
    const first = parseTsv(primary, week, rules || undefined);
    if (first.sheet && Object.keys(first.sheet.groups).length === first.sheet.headers.length) return first;
    const firstScore = resultScore(first, options);
    if (firstScore >= 10_000) return first;
    if (!week && group) {
      const block = findGroupBlock(groupRows(readWords(primary)), group);
      if (block) {
        if (!enhanced) throw new InputError('Не удалось подготовить таблицу. Попробуйте переслать снимок в формате PNG или JPEG.');
        const strip = numberStrip(await readFile(cleaned), block);
        await writeFile(numbersPath, strip.image);
        const numberLanguage = languages.split('+').includes('rus') ? 'rus' : languages;
        const [numberTsv, alternateTsv] = await Promise.all([
          scan(numbersPath, '6', numberLanguage, ['-c', 'tessedit_char_whitelist=0123456789,-']),
          scan(cleaned, '11'),
        ]);
        const numbers = new Map(readWords(numberTsv).map(word => [strip.rowIndex(word.y), word.text]));
        const alternateWords = readWords(alternateTsv);
        const raw = formatGroupBlock(block, numbers, alternateWords, { group, subgroup });
        const other = subgroup === 1 ? 2 : 1;
        try {
          const otherRaw = formatGroupBlock(block, numbers, alternateWords, { group, subgroup: other });
          if (otherRaw) {
            parseChangesMessage(otherRaw, key, now);
            const bySubgroup = { [other]: otherRaw };
            if (raw) bySubgroup[subgroup] = raw;
            return { table: null, raw: raw || otherRaw, bySubgroup };
          }
        } catch (error) {
          if (!(error instanceof InputError)) throw error;
          if (!raw) throw error;
        }
        if (!raw) throw new InputError('Для этих подгрупп в таблице нет замен.');
        return { table: null, raw };
      }
    }
    const second = await perform(enhanced ? cleaned : path, week ? '6' : '11').catch(() => null);
    const original = enhanced ? await perform(path, week ? '11' : '6').catch(() => null) : null;
    const sheets = [first, second, original].filter(result => result?.sheet);
    if (sheets.length) return sheets.reduce((best, next) =>
      Object.keys(next.sheet.groups).length > Object.keys(best.sheet.groups).length ? next : best);
    return [first, second, original].filter(Boolean).reduce((best, candidate) =>
      resultScore(candidate, options) > resultScore(best, options) ? candidate : best);
  } catch (error) {
    if (error instanceof InputError) throw error;
    if (error.code === 'ENOENT') {
      throw new Error('Для фото установите Tesseract OCR с русским языком. Пока можно отправить расписание текстом.');
    }
    if (/Failed loading language|Error opening data file/u.test(error.stderr || '')) {
      throw new Error('В Tesseract отсутствует языковой пакет. Проверьте настройку по инструкции или отправьте расписание текстом.');
    }
    throw new Error('Не удалось распознать изображение. Попробуйте фото крупнее или отправьте уроки текстом.');
  } finally {
    await Promise.all([path, bitmap, cleaned, numbersPath, cropPath].map(file => unlink(file).catch(() => {})));
    await rmdir(directory).catch(() => {});
  }
}
