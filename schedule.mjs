export const days = [
  'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье',
];
const dayPrefixes = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];
const zonedDate = new Intl.DateTimeFormat('sv-SE', {
  timeZone: process.env.SCHEDULE_TZ || 'Europe/Minsk',
  year: 'numeric', month: '2-digit', day: '2-digit',
});

export const baseExample = 'Понедельник\n1. Математика\n2. Русский язык\n\nВторник\n1. История';
export const changesExample = '2. Информатика, каб. 18\n4. отмена';
export class InputError extends Error {}

export function dayIndex(value) {
  const word = value.toLowerCase().trim().replace(/[.:]+$/u, '');
  return days.findIndex((day, index) => word === day.toLowerCase() || word === dayPrefixes[index]);
}

export function dateKey(input, now = new Date()) {
  const today = zonedDate.format(now);
  const value = input.trim().toLowerCase();
  if (value === 'сегодня') return today;
  if (value === 'завтра') {
    const date = new Date(today + 'T00:00:00Z');
    date.setUTCDate(date.getUTCDate() + 1);
    return date.toISOString().slice(0, 10);
  }
  const match = /^(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))?$/u.exec(value);
  const key = match
    ? [match[3] || today.slice(0, 4), match[2].padStart(2, '0'), match[1].padStart(2, '0')].join('-')
    : value;
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(key)) return null;
  const date = new Date(key + 'T00:00:00Z');
  return !Number.isNaN(+date) && date.toISOString().slice(0, 10) === key ? key : null;
}

export function lessonLine(line) {
  const match = /^0?(\d{1,2})(?:[.)\]:|–—-]\s*|\s*урок\s*[:.–—-]?\s*|\s+)(\S.*)$/iu.exec(line.trim());
  if (!match || +match[1] > 20) return null;
  return [+match[1], match[2].trim()];
}

const rangePrefix = /^(\d{1,2})\s*([,–—-]|\sи\s)\s*(\d{1,2})(?:\s*урок(?:и|а)?\s*[:.–—-]?\s*|[.):|–—-]\s*|\s+)(\S.*)$/iu;

export function lessonEntries(line) {
  const cleaned = line.trim().replace(/^[•●▪]\s*/u, '').replace(/^№\s*/u, '');
  const range = rangePrefix.exec(cleaned);
  if (!range) {
    const lesson = lessonLine(cleaned);
    return lesson ? [lesson] : [];
  }
  const [, first, separator, last, subject] = range;
  const start = +first;
  const end = +last;
  if (start >= end || end > 20) return [];
  return /[,и]/u.test(separator.toLowerCase())
    ? [[start, subject], [end, subject]]
    : Array.from({ length: end - start + 1 }, (_, index) => [start + index, subject]);
}

function addLesson(entries, [number, subject]) {
  if (subject.length > 100) throw new InputError('Название урока должно быть короче 101 символа.');
  if (Object.hasOwn(entries, number)) throw new InputError(`Номер урока ${number} повторяется.`);
  entries[number] = subject;
}

export function parseBase(text) {
  const week = {};
  let day = -1;
  for (const line of text.split(/\r?\n/u).map(line => line.trim()).filter(Boolean)) {
    const index = dayIndex(line);
    if (index >= 0) {
      day = index;
      week[day] ??= {};
      continue;
    }
    const lesson = lessonLine(line);
    if (!lesson || day < 0) throw new InputError(`Проверьте строку «${line.slice(0, 100)}». Нужны день недели и строки вида «1. Математика».`);
    addLesson(week[day], lesson);
  }
  if (!Object.values(week).some(lessons => Object.keys(lessons).length)) {
    throw new InputError('Добавьте хотя бы один урок.');
  }
  return week;
}

export function parseChanges(text) {
  const changes = {};
  for (const line of text.split(/\r?\n/u).map(line => line.trim()).filter(Boolean)) {
    const entries = lessonEntries(line);
    if (!entries.length || entries.some(([, subject]) =>
      (!/\p{L}/u.test(subject) && !/^[-–—]$/u.test(subject)) || /^\d+\s*[:.)]\s*\p{L}/u.test(subject))) {
      throw new InputError(`Проверьте строку «${line.slice(0, 100)}». Укажите номер и новый урок или «отмена».`);
    }
    for (const lesson of entries) addLesson(changes, lesson);
  }
  if (!Object.keys(changes).length) throw new InputError('Добавьте хотя бы одну замену.');
  return changes;
}

export function normalizeGroup(input) {
  const value = input.trim().toUpperCase().replace(/[–—‑]/gu, '-').replace(/\s+/gu, '')
    .replace(/[ABCEHKMOPTXY]/gu, letter => 'АВСЕНКМОРТХУ'['ABCEHKMOPTXY'.indexOf(letter)]);
  const match = /^([А-ЯЁA-Z]{1,8})-?(\d{1,4}[А-ЯЁA-Z]?)$/u.exec(value);
  return match ? match[1] + '-' + match[2] : null;
}

export function parseChangesMessage(text, selectedDate, now = new Date(), group) {
  const lines = text.replace(/[\u00ad\u200b\ufeff]/gu, '').split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
  let groupSeen = false;
  let removed = 0;
  for (const line of lines) {
    const heading = line.replace(/^(?:📅|🗓️?)\s*/u, '').replace(/[.!:]$/u, '');
    const dateHeading = heading.replace(/^замены\s+(?:на\s+)?/iu, '');
    const key = dateKey(dateHeading, now);
    if (key) {
      if (selectedDate && key !== selectedDate) {
        throw new InputError('Дата в сообщении отличается от выбранной. Нажмите «Добавить замены», чтобы выбрать другую дату.');
      }
    } else if (/^замены(?:\s+расписания)?$/iu.test(heading)) {
      // A title without a date can precede the selected day's list.
    } else if (!groupSeen && /^(?:(?:гр(?:уппа)?\.?\s*)[\p{L}\d-]+|[\p{L}]{1,8}\s*[-–]\s*\d{1,5})$/iu.test(heading)) {
      const printed = normalizeGroup(heading.replace(/^гр(?:уппа)?\.?\s*/iu, ''));
      if (group && printed && group !== printed) throw new InputError(`В сообщении указана группа ${printed}, а в вашей анкете — ${group}.`);
      groupSeen = true;
    } else {
      break;
    }
    removed++;
  }
  return parseChanges(lines.slice(removed).join('\n'));
}

export function setChanges(existing, updates) {
  const changes = { ...existing };
  for (const [number, subject] of Object.entries(updates)) {
    if (/^(по расписанию|сброс)$/iu.test(subject)) delete changes[number];
    else changes[number] = /^(отмена|отмен[её]н[оа]?|нет урока|[-–—])$/iu.test(subject) ? null : subject;
  }
  return changes;
}

const roomSuffix = /(?:^|[\s,–—])(?:каб(?:инет)?\.?\s*(?:№\s*)?([\p{L}\d][\p{L}\d./-]*)|(спортзал|мастерские|с\s*\/\s*з))\.?$/iu;
const roomCodeSuffix = /(?:^|[\s,–—])([\p{L}]?\d{1,4}[\p{L}]?)$/u;
const teacherSuffix = /(?:^|[\s,–—])[\p{L}][\p{L}’'-]*\s+(?:\p{Lu}\.\s*\p{Lu}\.?|\p{Lu}\s+\p{Lu}\.?|\p{Lu}\p{Lu}\.)$/u;

function trimSeparator(value) {
  return value.replace(/[\s,;–—]+$/u, '');
}

export function formatLesson(number, value) {
  if (value === null) return `${number}. Урок отменён`;
  let subject = value.trim();
  let room = '';
  const location = roomSuffix.exec(subject);
  if (location?.index > 0) {
    room = location[1] ? `каб. ${location[1].replace(/\.$/u, '')}` : location[2];
    subject = trimSeparator(subject.slice(0, location.index));
  } else {
    const code = roomCodeSuffix.exec(subject);
    if (code?.index > 0) {
      const beforeCode = subject.slice(0, code.index);
      if (/^[,–—]/u.test(code[0]) || /[,–—]\s*$/u.test(beforeCode) || teacherSuffix.test(trimSeparator(beforeCode))) {
        subject = trimSeparator(beforeCode);
        room = `каб. ${code[1]}`;
      }
    }
  }
  const teacher = teacherSuffix.exec(subject);
  if (teacher?.index > 0) subject = trimSeparator(subject.slice(0, teacher.index));
  return `${number}. ${[subject, room].filter(Boolean).join(' — ')}`;
}

export function formatWeek(week, { compact = false } = {}) {
  return Object.entries(week).map(([day, lessons]) =>
    [days[day], ...Object.entries(lessons).map(([number, subject]) =>
      compact ? formatLesson(number, subject) : `${number}. ${subject}`)].join('\n')
  ).join('\n\n');
}

export function formatDate(schedule, key) {
  const day = (new Date(key + 'T00:00:00Z').getUTCDay() + 6) % 7;
  const base = schedule.week?.[day] || {};
  const changes = schedule.changes?.[key] || {};
  const numbers = [...new Set([...Object.keys(base), ...Object.keys(changes)])].sort((a, b) => a - b);
  const title = `📅 ${days[day]}, ${key.split('-').reverse().join('.')}`;
  const lines = numbers.map(number => formatLesson(number, Object.hasOwn(changes, number) ? changes[number] : base[number]));
  return [title, '', ...(lines.length ? lines : ['На этот день уроков нет в сохранённом расписании.'])].join('\n');
}
