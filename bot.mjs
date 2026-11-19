import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { recognize } from './ocr.mjs';
import { firstWeek } from './mo34-first-week.mjs';
import { parseWeeklySheetText } from './weekly-sheet.mjs';
import {
  baseExample, changesExample, dateKey, formatDate, formatLesson, formatWeek,
  InputError, normalizeGroup, parseBase, parseChangesMessage, setChanges,
} from './schedule.mjs';

const buttons = {
  today: '📅 Сегодня', tomorrow: '📅 Завтра', date: '🗓 Другая дата',
  upload: '📷 Загрузить расписание', changes: '📤 Загрузить замены', get: '📥 Получить замены', week: '📚 Основное расписание',
};
const menu = {
  keyboard: [
    [buttons.today, buttons.tomorrow, buttons.date],
    [buttons.get, buttons.changes],
    [buttons.week, buttons.upload],
    ['👤 Моя анкета', '👥 Подгруппа'],
  ],
  resize_keyboard: true,
};
const commands = [
  { command: 'start', description: 'Открыть меню' },
  { command: 'schedule', description: 'Загрузить основное расписание' },
  { command: 'changes', description: 'Добавить замены' },
  { command: 'latest', description: 'Получить последние замены' },
  { command: 'profile', description: 'Выбрать группу и подгруппу' },
  { command: 'today', description: 'Расписание на сегодня' },
  { command: 'tomorrow', description: 'Расписание на завтра' },
  { command: 'day', description: 'Расписание на другую дату' },
  { command: 'week', description: 'Основное расписание на неделю' },
  { command: 'subgroup', description: 'Выбрать подгруппу' },
  { command: 'cancel', description: 'Выйти из режима ввода' },
];
const datePrompt = 'Напишите «сегодня», «завтра» или дату в формате ДД.ММ.ГГГГ.';
const basePrompt = `Пришлите листы ПТО и ССО альбомом или двумя изображениями подряд. Лучше отправить исходные изображения как файлы. Когда оба листа появятся в черновике, нажмите «Опубликовать расписание». Можно также загрузить один лист или расписание своей подгруппы.

${baseExample}`;

class TelegramError extends Error {
  constructor(method, code, retryAfter) {
    super(`${method}: Telegram API (${code})`);
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

export function telegram(token) {
  const origin = 'https://api.telegram.org';
  return {
    async call(method, params = {}) {
      const response = await fetch(`${origin}/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(method === 'getUpdates' ? 45_000 : 20_000),
      });
      const result = await response.json();
      if (!response.ok || !result.ok) {
        throw new TelegramError(method, result.error_code || response.status, result.parameters?.retry_after);
      }
      return result.result;
    },
    async image(fileId) {
      const file = await this.call('getFile', { file_id: fileId });
      const response = await fetch(`${origin}/file/bot${token}/${file.file_path}`, {
        signal: AbortSignal.timeout(25_000),
      });
      if (!response.ok) throw new TelegramError('download', response.status);
      return Buffer.from(await response.arrayBuffer());
    },
  };
}

export function storage(directory) {
  return {
    async read(chat) {
      try {
        return JSON.parse(await readFile(join(directory, `${chat}.json`), 'utf8'));
      } catch (error) {
        if (error.code === 'ENOENT') return {};
        throw error;
      }
    },
    async save(chat, schedule) {
      await mkdir(directory, { recursive: true });
      const temp = join(directory, `${chat}-${randomUUID()}.tmp`);
      try {
        await writeFile(temp, JSON.stringify(schedule, null, 2), { flag: 'wx' });
        await rename(temp, join(directory, `${chat}.json`));
      } finally {
        await unlink(temp).catch(error => {
          if (error.code !== 'ENOENT') throw error;
        });
      }
    },
  };
}

const groups = ['МО-34', 'ЭС-10', 'ЭМ-11', 'НМ-12', 'СК-13', 'ЭС-22', 'СМ-23', 'ОС-24', 'ЭС-32', 'НС-33', 'ТТ-12', 'ТЭ-21', 'ТТ-22', 'Т-23', 'ТМ-24', 'ТМ-34', 'Т-43', 'ТМ-44'];
export async function importPreviousSchedules(store, directory) {
  const group = normalizeGroup(process.env.SCHEDULE_GROUP || 'МО-34') || 'МО-34';
  const key = 'group-' + group;
  const shared = await store.read(key);
  if (shared.legacyImported) return;
  const files = await readdir(directory).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const profiles = { ...shared.subgroups };
  for (const file of files.filter(name => /^\d+\.json$/u.test(name)).sort()) {
    const user = await store.read(file.slice(0, -5));
    if (user.group) continue;
    const legacy = user.subgroups || { [process.env.SCHEDULE_SUBGROUP === '1' ? 1 : 2]: user };
    for (const [n, item] of Object.entries(legacy)) {
      const current = profiles[n] || {};
      const changes = { ...current.changes };
      for (const [date, entries] of Object.entries(item.changes || {})) changes[date] = { ...entries, ...changes[date] };
      profiles[n] = { week: current.week || item.week, changes };
    }
  }
  await store.save(key, { ...shared, subgroups: profiles, legacyImported: true });
}

function chunks(value, size = 3800) {
  const parts = [];
  while (value.length > size) {
    const newline = value.lastIndexOf('\n', size);
    const end = newline > 0 ? newline : size;
    parts.push(value.slice(0, end));
    value = value.slice(end + (newline > 0 ? 1 : 0));
  }
  if (value) parts.push(value);
  return parts;
}

function messageImage(message) {
  if (message.photo?.length) {
    return message.photo.reduce((largest, photo) =>
      photo.width * photo.height > largest.width * largest.height ? photo : largest);
  }
  const document = message.document;
  if (!document) return null;
  if (/^image\/(jpeg|png|webp|tiff|bmp|x-ms-bmp)$/u.test(document.mime_type || '')) return document;
  if ((!document.mime_type || document.mime_type === 'application/octet-stream') &&
      /\.(jpe?g|png|webp|tiff?|bmp)$/iu.test(document.file_name || '')) return document;
  return null;
}

export function createHandler(api, store, { ocr = recognize, now = () => new Date() } = {}) {
  const sessions = new Map();
  const date = value => dateKey(value, now());
  const ptoCatalog = readFile(new URL('./pto-weekly.json', import.meta.url), 'utf8').then(JSON.parse);

  return async update => {
    const query = update.callback_query;
    const message = query?.message || update.message;
    const chat = message?.chat;
    if (chat?.type !== 'private') return;
    const id = chat.id;
    const saved = await store.read(id);
    const session = sessions.get(id);
    const group = saved.group;
    const subgroup = saved.selectedSubgroup;
    const groupKey = 'group-' + group;
    const shared = group ? await store.read(groupKey) : {};
    const catalog = group ? await store.read('weekly-catalog') : {};
    const profiles = {
      ...(group === 'МО-34' ? { 1: { week: firstWeek } } : {}),
      ...shared.subgroups,
    };
    const initial = await ptoCatalog;
    for (const [number, week] of Object.entries({ ...initial[group], ...catalog[group] })) {
      profiles[number] = { ...profiles[number], week };
    }
    const profile = profiles[subgroup] || {};
    const label = `${group} · ${subgroup}-я подгруппа`;
    const saveProfiles = async updates => {
      await store.save(groupKey, { ...shared, subgroups: { ...profiles, ...updates } });
    };
    const { text = '' } = message;
    const send = async (value, markup = menu) => {
      const parts = chunks(value);
      for (const [index, part] of parts.entries()) {
        await api.call('sendMessage', {
          chat_id: id, text: part, reply_markup: index === parts.length - 1 ? markup : undefined,
        });
      }
    };
    const showDay = async key => send(label + '\n' + (profile.week || profile.changes?.[key]
      ? formatDate(profile, key)
      : 'Основное расписание этой подгруппы ещё не опубликовано.'));
    const selectSubgroup = async (number, chosenGroup = group) => {
      await store.save(id, { group: chosenGroup, selectedSubgroup: number });
      sessions.delete(id);
      await send(`${chosenGroup} · ${number}-я подгруппа. Нажмите «Получить замены» или загрузите фото для группы.`);
    };
    const askChangesDate = async fileId => {
      const requestId = randomUUID();
      const reference = now();
      const dates = ['сегодня', 'завтра'].map(label => dateKey(label, reference));
      sessions.set(id, { mode: 'changes-date', requestId, fileId, dates });
      const prompt = fileId ? 'Фото получено. На какую дату внести замены?' : 'На какую дату внести замены?';
      await send(`${prompt}\nДля другой даты отправьте её в формате ДД.ММ.ГГГГ.`, {
        inline_keyboard: [[
          { text: `Сегодня · ${dates[0].slice(5).split('-').reverse().join('.')}`, callback_data: `date:${requestId}:0` },
          { text: `Завтра · ${dates[1].slice(5).split('-').reverse().join('.')}`, callback_data: `date:${requestId}:1` },
        ]],
      });
    };
    const startChanges = async (key, fileId) => {
      if (fileId) {
        await readPhoto(fileId, key);
        return;
      }
      sessions.set(id, { mode: 'changes', key });
      await send(`Замены на ${key.split('-').reverse().join('.')}. Перешлите фото или сообщение с заменами. Можно написать по одной замене в строке.

${changesExample}

Чтобы вернуть обычный урок, напишите «2. по расписанию».`);
    };
    const saveBase = async week => {
      if (catalog[group]?.[subgroup] || initial[group]?.[subgroup]) {
        await store.save('weekly-catalog', { ...catalog, [group]: { ...catalog[group], [subgroup]: week } });
      } else await saveProfiles({ [subgroup]: { ...profile, week } });
      sessions.delete(id);
      await send('Основное расписание сохранено. Нажмите «Сегодня» или «Завтра», чтобы посмотреть уроки.');
    };
    const previewWeeklySheet = async (incoming, missing = []) => {
      const prior = sessions.get(id)?.draft;
      const weeks = { ...prior?.weeks };
      for (const [name, entries] of Object.entries(incoming)) weeks[name] = { ...weeks[name], ...entries };
      const names = Object.keys(weeks);
      if (!Object.keys(incoming).length) throw new InputError('На последнем листе видны группы, но расписание не удалось прочитать. Пришлите этот лист в полном размере.');
      const draft = { id: randomUUID(), weeks, files: (prior?.files || 0) + 1 };
      sessions.set(id, { mode: 'base', draft });
      const summary = names.map(name => {
        const counts = Object.entries(weeks[name]).map(([number, week]) =>
          `${number}-я п/г — ${Object.values(week).reduce((total, day) => total + Object.keys(day).length, 0)} уроков`);
        return name + ' · ' + counts.join(', ');
      });
      const partial = missing.length ? '\nНужно загрузить более чёткий фрагмент для ' + missing.join(', ') + '.' : '';
      const selected = weeks[group]?.[subgroup];
      await send(`В черновике листов: ${draft.files}. Можно отправить следующий лист или опубликовать расписание.\n\n` + summary.join('\n') + partial +
        (selected ? '\n\n' + label + '\n' + formatWeek(selected, { compact: true }) : ''), {
        inline_keyboard: [[{ text: '✅ Опубликовать расписание', callback_data: `save:${draft.id}` }]],
      });
    };
    const publishWeeklySheet = async weeks => {
      const next = { ...catalog };
      for (const [name, subgroups] of Object.entries(weeks)) {
        next[name] = { ...next[name], ...subgroups };
      }
      await store.save('weekly-catalog', next);
      sessions.delete(id);
      await send('Расписание опубликовано для групп ' + Object.keys(weeks).join(', ') + '. Студенты увидят его в кнопке «Основное расписание».');
    };
    const saveChanges = async (key, updates, bySubgroup = { [subgroup]: updates }) => {
      const next = {};
      for (const [number, entries] of Object.entries(bySubgroup)) {
        const previous = profiles[number] || {};
        next[number] = { ...previous, changes: { ...previous.changes, [key]: setChanges(previous.changes?.[key], entries) } };
      }
      await saveProfiles(next);
      sessions.delete(id);
      await send(label + '\n' + formatDate(next[subgroup] || profile, key));
    };

    const readPhoto = async (fileId, key) => {
      const isChange = Boolean(key);
      const current = isChange ? { mode: 'changes', key } : { mode: 'base', draft: session?.mode === 'base' ? session.draft : undefined };
      sessions.set(id, current);
      await send('Распознаю фото…');
      const image = await api.image(fileId);
      let extracted;
      try {
        extracted = await ocr(image, { week: !isChange, key, now: now(), group, subgroup });
      } catch (error) {
        if (/^(Для фото|В Tesseract|Не удалось)/u.test(error.message)) throw new InputError(error.message);
        throw error;
      }
      if (!isChange && extracted.sheet) {
        await previewWeeklySheet(extracted.sheet.groups, extracted.sheet.headers.filter(name =>
          Object.keys(extracted.sheet.groups[name] || {}).length < 2));
        return;
      }
      if (!isChange && current.draft?.weeks) throw new InputError('Второй лист не удалось разобрать как общую таблицу. Пришлите его целиком в более высоком разрешении.');
      const { table, raw } = extracted;
      let parsed;
      let preview;
      try {
        if (isChange) {
          parsed = parseChangesMessage(raw, key, now(), group);
          preview = Object.entries(parsed).map(([number, subject]) => formatLesson(number, subject)).join('\n');
        } else {
          parsed = parseBase(table ? formatWeek(table) : raw);
          preview = formatWeek(parsed, { compact: true });
        }
      } catch (error) {
        if (!(error instanceof InputError)) throw error;
        if (raw) await send('Распознанный черновик\n\n' + raw);
        await send(isChange
          ? `${error.message}\n\nПерешлите более чёткое фото или отправьте исправленный список по образцу.\n\n${changesExample}`
          : 'Пришлите более чёткое фото или добавьте дни недели и номера уроков в распознанный текст. ' + basePrompt);
        return;
      }
      const both = {};
      if (isChange && extracted.bySubgroup) {
        for (const [number, rawText] of Object.entries(extracted.bySubgroup)) {
          both[number] = parseChangesMessage(rawText, key, now(), group);
        }
        preview = Object.entries(both).map(([number, entries]) =>
          `${number}-я подгруппа\n${Object.entries(entries).map(([slot, value]) => formatLesson(slot, value)).join('\n')}`
        ).join('\n\n');
      } else {
        preview = label + '\n' + preview;
      }
      current.draft = { id: randomUUID(), data: parsed, both: extracted.bySubgroup ? both : undefined };
      const title = isChange ? `Замены на ${key.split('-').reverse().join('.')}\n` : '';
      const instruction = current.draft.both
        ? 'Проверьте подписи подгрупп. «Сохранить» применит все показанные замены. Исправления текстом относятся к выбранной подгруппе.'
        : 'Проверьте распознанные уроки. Нажмите «Сохранить» или отправьте исправленный список текстом.';
      await send(title + instruction + '\n\n' + preview, {
        inline_keyboard: [[{ text: '✅ Сохранить', callback_data: `save:${current.draft.id}` }]],
      });
    };

    try {
      const input = text.trim();
      const editProfile = /^(?:\/profile(?:@\w+)?|👤 Моя анкета)$/u.test(input);
      if (!query && (editProfile || (!group && !session) || (input === '/start' && !group))) {
        sessions.set(id, { mode: 'pick-group' });
        const rows = [];
        for (let i = 0; i < groups.length; i += 4) rows.push(groups.slice(i, i + 4));
        await send('Выберите свою группу или напишите её название, например МО-34.', { keyboard: rows, resize_keyboard: true });
        return;
      }
      if (!query && group && ['/start', '/cancel'].includes(input) && session?.mode?.startsWith('pick-')) {
        sessions.delete(id);
        await send(label + '\nВыберите действие в меню.');
        return;
      }
      if (!query && session?.mode === 'pick-group') {
        const chosen = normalizeGroup(input);
        if (!chosen) {
          await send('Введите обозначение группы с номером, например МО-34.', { force_reply: true });
          return;
        }
        sessions.set(id, { mode: 'pick-subgroup', group: chosen });
        await send(`Группа ${chosen}. Выберите подгруппу.`, { keyboard: [['1-я подгруппа', '2-я подгруппа']], resize_keyboard: true });
        return;
      }
      if (!query && session?.mode === 'pick-subgroup') {
        const choice = /^([12])(?:-я подгруппа)?$/u.exec(input);
        if (choice) await selectSubgroup(Number(choice[1]), session.group);
        else await send('Выберите 1-ю или 2-ю подгруппу.', { keyboard: [['1-я подгруппа', '2-я подгруппа']], resize_keyboard: true });
        return;
      }
      if (query) {
        if (session?.mode === 'subgroup' && [1, 2].some(n => query.data === `group:${session.requestId}:${n}`)) {
          await api.call('answerCallbackQuery', { callback_query_id: query.id });
          await selectSubgroup(Number(query.data.slice(-1)));
          return;
        }
        if (session?.mode === 'changes-date') {
          const index = [0, 1].find(index => query.data === `date:${session.requestId}:${index}`);
          if (index !== undefined) {
            await api.call('answerCallbackQuery', { callback_query_id: query.id });
            await startChanges(session.dates[index], session.fileId);
            return;
          }
        }
        if (!session?.draft || query.data !== `save:${session.draft.id}`) {
          await api.call('answerCallbackQuery', { callback_query_id: query.id, text: 'Этот черновик уже недоступен.' });
          return;
        }
        await api.call('answerCallbackQuery', { callback_query_id: query.id });
        if (session.mode === 'changes') await saveChanges(session.key, session.draft.data, session.draft.both);
        else if (session.draft.weeks) await publishWeeklySheet(session.draft.weeks);
        else await saveBase(session.draft.data);
        return;
      }

      const [command, ...args] = text.trim().split(/\s+/u);
      const action = command.startsWith('/') ? command.split('@')[0].toLowerCase() : text.trim();
      const argument = args.join(' ');
      switch (action) {
        case '/start':
        case '/help': {
          sessions.delete(id);
          await send(label + '\n' + (profile.week
            ? 'Основное расписание сохранено. Перешлите фото с заменами или выберите день в меню.'
            : 'Нажмите «Получить замены» или загрузите расписание группы.'));
          return;
        }
        case '/latest':
        case buttons.get: {
          const latest = Object.keys(profile.changes || {}).filter(key => Object.keys(profile.changes[key]).length).sort().at(-1);
          if (latest) await showDay(latest);
          else await send(`${label}\nДля вашей подгруппы пока никто не загрузил замены.`);
          return;
        }
        case '/subgroup':
        case '👥 Подгруппа': {
          if (action === '/subgroup' && /^[12]$/u.test(argument)) {
            await selectSubgroup(Number(argument));
            return;
          }
          const requestId = randomUUID();
          sessions.set(id, { mode: 'subgroup', requestId });
          await send(`Сейчас выбрана ${subgroup}-я подгруппа. Какую открыть?`, {
            inline_keyboard: [[1, 2].map(n => ({ text: `${n}-я подгруппа`, callback_data: `group:${requestId}:${n}` }))],
          });
          return;
        }
        case '/cancel':
          sessions.delete(id);
          await send('Ввод отменён.');
          return;
        case '/today':
        case buttons.today:
          await showDay(date('сегодня'));
          return;
        case '/tomorrow':
        case buttons.tomorrow:
          await showDay(date('завтра'));
          return;
        case '/week':
        case buttons.week: {
          await send(label + '\n' + (profile.week ? formatWeek(profile.week, { compact: true }) : 'Сначала загрузите основное расписание.'));
          return;
        }
        case '/schedule':
        case buttons.upload:
          sessions.set(id, { mode: 'base' });
          await send(label + '\nЭто общее расписание вашей подгруппы. ' + basePrompt);
          return;
        case '/day':
        case buttons.date:
          if (action === '/day' && date(argument)) await showDay(date(argument));
          else {
            sessions.set(id, { mode: 'view-date' });
            await send(datePrompt);
          }
          return;
        case '/changes':
        case '✏️ Добавить замены':
        case buttons.changes:
          if (action === '/changes' && date(argument)) await startChanges(date(argument));
          else await askChangesDate();
          return;
      }

      const file = messageImage(message);
      if (file) {
        if (file.file_size > 20_000_000) throw new InputError('Пришлите изображение размером до 20 МБ.');
        if (session?.mode === 'base') await readPhoto(file.file_id);
        else if (session?.mode === 'changes') await readPhoto(file.file_id, session.key);
        else if (session?.mode === 'changes-date' || message.forward_origin || profile.week) {
          await askChangesDate(file.file_id);
        } else {
          await readPhoto(file.file_id);
        }
        return;
      }

      if (session?.mode === 'view-date' || session?.mode === 'changes-date') {
        const key = date(text);
        if (!key) throw new InputError(datePrompt);
        if (session.mode === 'changes-date') await startChanges(key, session.fileId);
        else {
          sessions.delete(id);
          await showDay(key);
        }
        return;
      }

      if (text && session?.mode === 'base') {
        const weeklySheet = parseWeeklySheetText(text);
        if (weeklySheet) await previewWeeklySheet(weeklySheet);
        else await saveBase(parseBase(text));
      }
      else if (text && session?.mode === 'changes') await saveChanges(session.key, parseChangesMessage(text, session.key, now(), group));
      else await send('Перешлите фото с заменами или выберите действие в меню.');
    } catch (error) {
      if (error instanceof InputError) await send(error.message);
      else throw error;
    }
  };
}

async function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token || !/^\d+:[\w-]+$/u.test(token)) {
    console.error('Укажите действительный TELEGRAM_BOT_TOKEN или запустите start.cmd.');
    process.exitCode = 1;
    return;
  }
  const api = telegram(token);
  const profile = await api.call('getMe');
  await api.call('setMyCommands', { commands });
  const directory = fileURLToPath(new URL('./data/', import.meta.url));
  const store = storage(directory);
  await importPreviousSchedules(store, directory);
  const handle = createHandler(api, store);
  console.log(`Бот запущен → https://t.me/${profile.username}`);
  let offset;
  while (true) {
    try {
      const updates = await api.call('getUpdates', { timeout: 30, offset, allowed_updates: ['message', 'callback_query'] });
      for (const update of updates) {
        try {
          await handle(update);
        } catch (error) {
          console.error(`Ошибка обработки сообщения (${error.code || error.name})`);
          const chat = update.message?.chat || update.callback_query?.message?.chat;
          if (chat?.type === 'private') {
            await api.call('sendMessage', { chat_id: chat.id, text: 'Возникла ошибка. Повторите действие или проверьте окно запуска бота.' }).catch(() => {});
          }
        }
        offset = update.update_id + 1;
      }
    } catch (error) {
      if ([401, 409].includes(error.code)) throw error;
      console.error(`Связь с Telegram прервалась (${error.code || error.name}). Повторяю запрос.`);
      await delay(error.retryAfter ? error.retryAfter * 1000 : 3000);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    if (error.code === 401) console.error('Telegram отклонил токен. Проверьте токен у @BotFather.');
    else if (error.code === 409) console.error('У этого бота уже есть запущенная копия или настроен webhook.');
    else console.error(`Не удалось запустить бота (${error.code || error.name}). Проверьте подключение к Telegram.`);
    process.exitCode = 1;
  });
}
