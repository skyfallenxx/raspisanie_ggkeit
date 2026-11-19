import { InputError, normalizeGroup } from './schedule.mjs';

const subjectAliases = new Map([
  ['офис', 'ОФИС'], ['черчение', 'Черчение'], ['инязык', 'Иностранный язык'],
  ['иностранныйязык', 'Иностранный язык'], ['экономика', 'Экономика'],
]);

function groupCode(value) {
  return normalizeGroup(value) || value.toUpperCase().replace(/[MO]/gu, letter => ({ M: 'М', O: 'О' })[letter])
    .replace(/[–—]/gu, '-').replace(/\s+/gu, '');
}

function leadingGroup(row) {
  const prefix = row.words.slice(0, 3).map(word => word.text).join(' ');
  const match = /^(?:[гтt][рp][.\s]*)([\p{L}]{1,4}\s*[-–—]\s*[\d\p{L}]{1,4})(?=\s|$)/iu.exec(prefix);
  return match ? groupCode(match[1]) : null;
}

function columns(row) {
  const first = row.words.findIndex(word => /^\d[\d.,–—-]*$/u.test(word.text));
  if (first < 0) return [];
  const cells = [];
  for (const word of row.words.slice(first)) {
    const cell = cells.at(-1);
    const previous = cell?.at(-1);
    if (!previous || word.left - previous.right >= row.height * 1.45) cells.push([word]);
    else cell.push(word);
  }
  return cells;
}

export function findGroupBlock(rows, group) {
  const groupRows = rows.flatMap((row, index) => {
    const code = leadingGroup(row);
    return code ? [{ code, index }] : [];
  });
  const index = groupRows.findIndex(row => row.code === groupCode(group));
  if (index < 0) {
    if (groupRows.length >= 2) throw new InputError(`В таблице не удалось найти группу ${group}. Перешлите более чёткое фото.`);
    return null;
  }
  const start = groupRows[index].index;
  const end = groupRows[index + 1]?.index ?? rows.length;
  const block = rows.slice(start, end);
  const template = block.map(columns).find(cells => cells.length === 5) ||
    rows.map(columns).find(cells => cells.length === 5 && /^\d/u.test(cells[4][0].text));
  if (!template) throw new InputError(`В блоке группы ${group} не удалось разделить столбцы. Перешлите более чёткое фото.`);
  const starts = template.map(cell => cell[0].left);
  const padding = Math.max(3, Math.round(block[0].height / 2));
  const cuts = starts.map(x => x - padding);
  const header = rows.slice(0, start).slice(0, 3).flatMap(row => row.words.map(word => word.text)).join(' ');
  const date = /(?:^|\s)(\d{1,2}\.\d{1,2}\.\d{4})(?=\s|$)/u.exec(header)?.[1];
  const entries = block.map(row => {
    const cells = starts.map(() => []);
    for (const word of row.words) {
      const column = cuts.findLastIndex(x => word.left >= x);
      if (column >= 0) cells[column].push(word.text);
    }
    return { y: row.y, cells: cells.map(cell => cell.join(' ')) };
  }).filter(row => row.cells[0] || row.cells[2]);
  return { date, rows: entries, cuts };
}

function alternateCells(block, rowIndex, words) {
  const row = block.rows[rowIndex];
  const start = rowIndex === 0 ? row.y - 12 : (block.rows[rowIndex - 1].y + row.y) / 2;
  const end = rowIndex === block.rows.length - 1 ? row.y + 12 : (row.y + block.rows[rowIndex + 1].y) / 2;
  const ordered = words.filter(word => word.y >= start && word.y < end).sort((a, b) => a.left - b.left);
  return block.cuts.map((left, index) => ordered
    .filter(word => word.left >= left && word.left < (block.cuts[index + 1] ?? Infinity))
    .map(word => word.text).join(' '));
}

export function numberStrip(pgm, block) {
  const header = /^P5\n(\d+) (\d+)\n255\n/u.exec(pgm.toString('ascii', 0, 64));
  if (!header) throw new Error('Unrecognized prepared image');
  const imageWidth = +header[1];
  const imageHeight = +header[2];
  const image = pgm.subarray(header[0].length);
  const left = Math.max(0, block.cuts[0]);
  const cellWidth = Math.min(imageWidth, block.cuts[1]) - left;
  const gaps = block.rows.slice(1).map((row, index) => row.y - block.rows[index].y).sort((a, b) => a - b);
  const cellHeight = Math.max(10, Math.round(gaps[Math.floor(gaps.length / 2)] || 22));
  const stride = 3 * cellHeight;
  const width = 2 * cellWidth + 36;
  const height = stride * block.rows.length + 26;
  const pixels = Buffer.alloc(width * height, 255);
  for (const [index, row] of block.rows.entries()) {
    const top = Math.round(row.y - cellHeight / 2);
    for (let y = 0; y < 2 * cellHeight; y++) {
      const sourceY = top + Math.floor(y / 2);
      if (sourceY < 0 || sourceY >= imageHeight) continue;
      const source = sourceY * imageWidth + left;
      const target = (13 + index * stride + y) * width + 18;
      for (let x = 0; x < 2 * cellWidth; x++) pixels[target + x] = image[source + Math.floor(x / 2)];
    }
  }
  return {
    image: Buffer.concat([Buffer.from(`P5\n${width} ${height}\n255\n`), pixels]),
    rowIndex: y => Math.floor((y - 13) / stride),
  };
}

function subjectKey(subject) {
  return subject.toLowerCase().replace(/[^а-яё]/gu, '');
}

function subjectFor(value, subgroup, splitExpected) {
  let parts = value.split(/\s*[/|]\s*/u);
  if (parts.length === 1 && splitExpected) {
    const key = subjectKey(value);
    for (const alias of subjectAliases.keys()) {
      if (key.startsWith(alias) && subjectAliases.has(key.slice(alias.length))) {
        parts = [alias, key.slice(alias.length)];
        break;
      }
    }
  }
  if (splitExpected && parts.length !== 2) return null;
  const subject = parts.length === 1 ? parts[0] : parts[subgroup - 1];
  if (!subject) return null;
  return subjectAliases.get(subjectKey(subject)) || subject.trim();
}

function teacherFor(value, subgroup) {
  const parts = value.split(/\s*\/\s*/u);
  const choice = parts.length === 1 ? parts[0] : parts[subgroup - 1];
  if (!choice) return '';
  const match = /^([\p{L}-]+)\s*([А-ЯЁABEKMHOPCTYX])\s*\.?\s*([А-ЯЁABEKMHOPCTYX])\s*[,.;]?$/iu.exec(choice.trim());
  if (!match) return choice.trim();
  const lookalikes = Object.fromEntries([...('ABEKMHOPCTYX')].map((letter, index) =>
    [letter, 'АВЕКМНОРСТУХ'[index]]));
  const initial = letter => lookalikes[letter.toUpperCase()] || letter.toUpperCase();
  const lastName = match[1].replace(/^Барабано[ЕE]$/iu, 'Барабанов');
  return `${lastName} ${initial(match[2])}. ${initial(match[3])}.`;
}

function roomFor(value, alternate, subgroup, splitExpected) {
  const clean = text => text.replace(/\s+/gu, '').replace(/(?<=\d)б(?=[а-яa-z]$)/iu, '6').replace(/a$/iu, 'а');
  const original = clean(value);
  let rooms = original.split('/');
  if (splitExpected && rooms.length === 1 && alternate.includes('/')) {
    rooms = clean(alternate).split('/');
    const joined = rooms.join('');
    if (rooms.length === 2 && original.startsWith(joined) && /^[абвг]$/iu.test(original.slice(joined.length))) {
      rooms[1] += original.slice(joined.length);
    }
  }
  const room = rooms.length === 1 ? rooms[0] : rooms[subgroup - 1];
  return /^(?:м?\d{1,3}[абвг]?|с\/?з)$/iu.test(room || '') ? room : '';
}

const validNumber = /^(?:[1-9]|1\d|20)$/u;

function lessonNumbersFor(primary, reread) {
  const candidates = [reread, primary].filter(Boolean).map(value => value.replace(/\s+/gu, ''));
  for (const candidate of candidates) {
    const range = candidate.split(/[-–—]/u);
    if (range.length === 2 && range.every(number => validNumber.test(number)) && +range[0] < +range[1]) {
      return [range.join('-')];
    }
    const list = candidate.split(',');
    if (list.length > 1 && list.every(number => validNumber.test(number)) &&
        list.every((number, index) => index === 0 || +number > +list[index - 1])) return list;
  }
  for (const candidate of candidates) {
    if (validNumber.test(candidate)) return [candidate];
    const digits = candidate.replaceAll(',', '');
    if (!/^\d{2,8}$/u.test(digits)) continue;
    const partitions = [];
    const split = (remaining, chosen) => {
      if (!remaining) {
        partitions.push(chosen);
        return;
      }
      for (const length of [1, 2]) {
        if (length > remaining.length) break;
        const number = remaining.slice(0, length);
        if (validNumber.test(number) && +number > +(chosen.at(-1) || 0)) split(remaining.slice(length), [...chosen, number]);
      }
    };
    split(digits, []);
    if (partitions.length === 1) return partitions[0];
  }
  return [];
}

export function formatGroupBlock(block, rereadNumbers, alternativeWords, { group, subgroup }) {
  const lines = [];
  const errors = [];
  for (const [index, row] of block.rows.entries()) {
    const [firstNumber, marker, subjects, teachers, rooms] = row.cells;
    const numbers = lessonNumbersFor(firstNumber, rereadNumbers.get(index));
    const markerText = marker.toLowerCase().replace(/\s+/gu, '').replace(/п\/?г\.?|подгруппа/gu, 'пг');
    const explicitSubgroup = /^([12])(?:пг|pg)$/u.exec(markerText);
    if (explicitSubgroup && +explicitSubgroup[1] !== subgroup) continue;
    const position = /^2(?:пг|pg)\/1(?:пг|pg)$/u.test(markerText) ? 3 - subgroup : subgroup;
    const splitExpected = Boolean(marker && !explicitSubgroup) &&
      [subjects, teachers, rooms].some(value => value.includes('/'));
    const [,, alternate, alternateTeachers, alternateRooms] = alternateCells(block, index, alternativeWords);
    const primarySubject = subjectFor(subjects, position, splitExpected);
    const alternateSubject = alternate.includes('/') && splitExpected ? subjectFor(alternate, position, true) : null;
    const knownSubjects = [...subjectAliases.values()];
    const subject = alternateSubject && (!subjects.includes('/') ||
      (!knownSubjects.includes(primarySubject) && knownSubjects.includes(alternateSubject)))
      ? alternateSubject : primarySubject;
    if (!numbers.length || !subject || (marker && !explicitSubgroup && !splitExpected)) {
      errors.push(row.cells.filter(Boolean).join(' | '));
      continue;
    }
    const primaryTeacher = teacherFor(teachers, position);
    const teacher = (!primaryTeacher || /^[a-z]/iu.test(primaryTeacher))
      ? teacherFor(alternateTeachers, position) || primaryTeacher : primaryTeacher;
    const room = roomFor(rooms, alternateRooms, position, splitExpected);
    for (const number of numbers) {
      const cancelled = /^(?:урока нет|уроков нет|отмена)$/iu.test(subject);
      lines.push(`${number}. ${cancelled ? 'отмена' : [subject, teacher, room && `каб. ${room}`].filter(Boolean).join(' — ')}`);
    }
  }
  if (errors.length) {
    const details = errors.length ? '\n\n' + errors.join('\n') : '';
    throw new InputError(`В блоке ${group} есть строки, которые нужно сверить. Перешлите более чёткое фото или введите замены текстом.${details}`);
  }
  if (!lines.length) return null;
  return [block.date, ...lines].filter(Boolean).join('\n');
}
