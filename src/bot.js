import { randomBytes } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import {
  currentDay, currentPeriod, exactDay, exactSchedule, InputError, labelPeriod, months, parseMonth, parseScope, parseYear,
  shiftDay, shiftMonth,
} from './periods.js';
import { categoryIcons, importanceLevels, taskStats } from './store.js';
import { maxVoiceBytes, maxVoiceSeconds, tasksFromSpeech } from './voice.js';

const pageSize = 6;
const reviewLifetime = 30 * 60 * 1000;
const importanceSymbols = { low: '◻️', medium: '🟡', high: '🔴', global: '🔵' };
const statusActions = {
  active: { label: 'Вернуть в активные', notice: 'Задача снова активна.' },
  done: { label: '✓', notice: 'Задача завершена.' },
  obsolete: { label: '🗑', notice: 'Задача отменена. Она в списке «Неактуальные».' },
};
const commands = {
  start: 'Открыть пространство пары',
  task: 'Добавить задачу',
  backlog: 'Показать бэклог',
  day: 'Задачи на день',
  month: 'Задачи месяца',
  year: 'Итоги года',
  major: 'Крупные задачи',
  review: 'Разобрать задачи месяца или года',
  invite: 'Пригласить партнёра',
  link: 'Подключить общий чат',
  unlink: 'Отключить общий чат',
  help: 'Показать команды',
};

export class TelegramApi {
  constructor(token, request = fetch) {
    this.token = token;
    this.request = request;
  }

  async call(method, body = {}, signal = AbortSignal.timeout(40_000)) {
    let result;
    try {
      const response = await this.request(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
      result = await response.json();
    } catch {
      const error = new Error(`Ошибка соединения с Telegram при вызове ${method}.`);
      error.retryable = true;
      throw error;
    }
    if (!result.ok) {
      const error = new Error(`Telegram: ${method}, код ${result.error_code} — ${result.description}`
        .replaceAll(this.token, '[скрыто]'));
      error.code = result.error_code;
      error.retryAfter = result.parameters?.retry_after;
      throw error;
    }
    return result.result;
  }

  async downloadVoice(fileId, signal) {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
    const file = await this.call('getFile', { file_id: fileId }, deadline);
    const parts = file.file_path?.split('/');
    if (!parts?.length || parts.some((part) => !/^[\w.-]+$/.test(part) || part === '.' || part === '..')) {
      throw new Error('Telegram не вернул путь к голосовому сообщению.');
    }
    if (file.file_size > maxVoiceBytes) throw new InputError('Запись слишком большая. Отправьте её двумя частями.');
    const response = await this.request('https://api.telegram.org/file/bot' + this.token + '/' + parts.join('/'), {
      signal: deadline, redirect: 'error',
    });
    if (!response.ok || !response.body) throw new Error('Не удалось скачать голосовое сообщение.');
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > maxVoiceBytes) throw new InputError('Запись слишком большая. Отправьте её двумя частями.');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, size);
  }
}

function button(text, callback) {
  return { text, callback_data: callback };
}

const groupStart = 'pair-chat';

export function groupSetupUrl(username) {
  return `https://t.me/${username}?startgroup=${groupStart}`;
}

function taskActionButtons(task, context) {
  return Object.entries(statusActions)
    .filter(([status]) => status !== task.status)
    .map(([status, { label }]) => button(label, `s2:${context}:${task.id}:${task.version}:${status}`));
}

function markup(rows) {
  return { inline_keyboard: rows.filter((row) => row.length) };
}

function brief(task, max = 125) {
  const line = task.parentTitle ? `${task.title} · к «${task.parentTitle}»` : task.title;
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function statsLine(stats) {
  const rate = stats.percent === null ? '—' : `${stats.percent}%`;
  return `Всего ${stats.total} · Выполнено ${stats.done} · Активно ${stats.active} · Неактуально ${stats.obsolete}\nДоля выполненных ${rate}`;
}

function strike(text, offset = 0) {
  return { type: 'strikethrough', offset, length: text.length };
}

function activeSubtaskWarning(count) {
  return `Активных подзадач: ${count}. Можно завершить их или оставить открытыми. Чтобы сделать подзадачу самостоятельной или удалить её, откройте её карточку в Mini App.`;
}

function matches(task, scope) {
  return task.status === 'active' && task.importance !== 'global' && Boolean(task.period?.startsWith(scope));
}

function shiftSchedule(period, step) {
  if (period.length === 10) return shiftDay(period, step);
  if (period.length === 7) return shiftMonth(period, step);
  const year = Number(period) + step;
  return year >= 1000 && year <= 9999 ? String(year) : null;
}

function readCommand(message, username) {
  const entity = message.entities?.[0];
  if (entity?.type !== 'bot_command' || entity.offset !== 0) return null;
  const [name, recipient] = message.text.slice(1, entity.length).toLowerCase().split('@');
  if (recipient && recipient !== username.toLowerCase()) return { name: '', args: '' };
  return { name, args: message.text.slice(entity.length).trim() };
}

export class Bot {
  constructor({ api, store, username, appUrl, timeZone, transcribe, now = () => new Date() }) {
    Object.assign(this, { api, store, username, appUrl, timeZone, transcribe, now });
    this.reviews = new Map();
  }

  get period() {
    return currentPeriod(this.timeZone, this.now());
  }

  send(message, text, replyMarkup, entities) {
    const request = { chat_id: message.chat.id, text, reply_markup: replyMarkup, entities };
    if (message.message_thread_id) request.message_thread_id = message.message_thread_id;
    return this.api.call('sendMessage', request);
  }

  async show(ctx, text, rows = [], entities = []) {
    if (!ctx.callback) return this.send(ctx.message, text, markup(rows), entities);
    try {
      await this.api.call('editMessageText', {
        chat_id: ctx.message.chat.id,
        message_id: ctx.message.message_id,
        text,
        reply_markup: markup(rows),
        entities,
      });
    } catch (error) {
      if (!error.message.includes('message is not modified')) throw error;
    }
  }

  appButton(message) {
    if (!this.appUrl) return [];
    return [message.chat.type === 'private'
      ? { text: 'Открыть Mini App', web_app: { url: this.appUrl } }
      : { text: 'Mini App в личном чате', url: `https://t.me/${this.username}?start=app` }];
  }

  groupButton() {
    return { text: 'Добавить бота в группу', url: groupSetupUrl(this.username) };
  }

  homeRows({ message, space }) {
    return [
      [button('＋ Добавить задачу', 'add'), button('Бэклог', 'l:all:active:0')],
      [button('Сегодня', `l:${currentDay(this.timeZone, this.now())}:active:0`), button('Текущий месяц', `l:${this.period}:all:0`)],
      [button('Текущий год', `y:${this.period.slice(0, 4)}`), button('Крупные', 'l:major:active:0')],
      this.appButton(message),
      message.chat.type === 'private' && space.groupChat === null ? [this.groupButton()] : [],
    ];
  }

  async handle(update) {
    const callback = update.callback_query;
    const message = callback?.message ?? update.message;
    const user = callback?.from ?? message?.from;
    if (!message) {
      if (callback) await this.api.call('answerCallbackQuery', { callback_query_id: callback.id });
      return;
    }
    if (message.migrate_to_chat_id || message.migrate_from_chat_id) {
      this.store.applyTelegramAction(update.update_id, () => {
        if (message.migrate_to_chat_id) this.store.migrateGroup(message.chat.id, message.migrate_to_chat_id);
        else this.store.migrateGroup(message.migrate_from_chat_id, message.chat.id);
      });
    }
    if (!user || user.is_bot) return;

    for (const [id, review] of this.reviews) if (review.expires <= Date.now()) this.reviews.delete(id);
    const ctx = {
      callback, message, user: user.id, firstName: user.first_name, private: message.chat.type === 'private',
      space: this.store.spaceFor(user.id), updateId: update.update_id,
    };
    if (ctx.space) this.store.rememberMemberName(ctx.user, ctx.firstName);
    if (callback) {
      let notice;
      try {
        this.requireAccess(ctx);
        notice = await this.onButton(ctx, callback.data ?? '');
      } catch (error) {
        if (!(error instanceof InputError)) throw error;
        notice = error.message;
      } finally {
        await this.api.call('answerCallbackQuery', { callback_query_id: callback.id, text: notice?.slice(0, 200) })
          .catch((error) => { if (error.code !== 400) console.error(error.message); });
      }
      return;
    }
    if (message.voice && ctx.private && this.transcribe) {
      try {
        this.requireAccess(ctx);
        this.queueVoice(ctx);
      } catch (error) {
        if (!(error instanceof InputError)) throw error;
        await this.send(message, error.message);
      }
      return;
    }
    if (typeof message.text !== 'string') return;

    const command = readCommand(message, this.username);
    const prompt = this.store.taskPrompt(message.chat.id, ctx.user);
    const isReply = prompt && message.reply_to_message?.message_id === prompt.messageId;
    if (!command && !isReply && !this.store.hasTelegramAction(ctx.updateId)) return;

    try {
      if (command) await this.onCommand(ctx, command.name, command.args);
      else {
        this.requireAccess(ctx);
        await this.addTask(ctx, message.text, true);
      }
    } catch (error) {
      if (!(error instanceof InputError)) throw error;
      await this.send(message, error.message);
    }
  }

  applyAction(ctx, action) {
    return this.store.applyTelegramAction(ctx.updateId, action);
  }

  queueVoice(ctx) {
    const { voice, message_id: messageId, chat } = ctx.message;
    if (voice.duration > maxVoiceSeconds) {
      throw new InputError('Отправьте голосовое длительностью до 90 секунд.');
    }
    if (voice.file_size > maxVoiceBytes) {
      throw new InputError('Запись слишком большая. Отправьте её двумя частями.');
    }
    this.applyAction(ctx, () => this.store.queueVoice(ctx.space.id, ctx.user, chat.id, messageId, voice.file_id));
  }

  async processVoices(signal) {
    if (!this.transcribe) return;
    while (!signal.aborted) {
      const job = this.store.pendingVoice();
      if (job) await this.processVoice(job, signal);
      else await setTimeout(400, undefined, { signal }).catch((error) => {
        if (error.name !== 'AbortError') throw error;
      });
    }
  }

  async processVoice(job, signal) {
    let titles = [];
    let reply;
    try {
      const audio = await this.api.downloadVoice(job.fileId, signal);
      titles = tasksFromSpeech(await this.transcribe(audio, signal));
      reply = 'Добавлено в бэклог:\n' + titles.map((title) => '• ' + title).join('\n');
    } catch (error) {
      if (signal.aborted) return;
      if (!(error instanceof InputError)) console.error('Не удалось распознать голосовое сообщение.');
      reply = error instanceof InputError ? error.message : 'Не получилось распознать голосовое. Попробуйте отправить его ещё раз.';
    }
    if (signal.aborted) return;
    const tasks = this.store.completeVoice(job, titles);
    const context = 'all:active:0';
    const rows = tasks.map((task) => [
      button(tasks.length === 1 ? 'Открыть задачу' : brief(task, 45), `t2:${context}:${task.id}`),
    ]);
    if (tasks.length === 1) rows.unshift(taskActionButtons(tasks[0], context));
    if (tasks.length > 1) reply += '\n\nЧтобы завершить или отменить задачу, нажмите на её название.';
    await this.api.call('sendMessage', {
      chat_id: job.chat, text: reply,
      reply_markup: rows.length ? markup(rows) : undefined,
      reply_parameters: { message_id: job.message, allow_sending_without_reply: true },
    }, AbortSignal.any([signal, AbortSignal.timeout(10_000)])).catch(() => {
      if (!signal.aborted) console.error('Не удалось отправить результат распознавания.');
    });
  }

  requireAccess(ctx) {
    if (!ctx.space || !ctx.private && ctx.space.groupChat !== ctx.message.chat.id) {
      throw new InputError(ctx.private ? 'Откройте пространство командой /start.' : 'Нужен подключённый чат пары.', 403);
    }
  }

  async onCommand(ctx, name, args) {
    if (!Object.hasOwn(commands, name)) return;
    const { message, user } = ctx;
    if (name === 'start' && ctx.private) {
      const existing = ctx.space;
      ctx.space = this.applyAction(ctx, () => this.store.joinOrCreate(user, args === 'app' ? '' : args));
      if (!existing) this.store.rememberMemberName(user, ctx.firstName);
      if (ctx.space.pendingJoin) {
        const { token, taskCount } = ctx.space.pendingJoin;
        const lines = [
          'Присоединиться к пространству партнёра?',
          `Задачи из вашего пространства (${taskCount}) и категории станут общими. Ваше прежнее приглашение перестанет действовать.`,
        ];
        if (ctx.space.groupChat !== null) lines.push('Ваш прежний общий чат будет отключён.');
        return this.show(ctx, lines.join('\n\n'), [
          [button('Перенести задачи и присоединиться', `join:${token}:${ctx.space.id}`)],
          [button('Остаться в своём пространстве', 'stay')],
        ]);
      }
      const text = ctx.space.invite
        ? `Ваше пространство готово. Пригласите партнёра по ссылке:\n${this.inviteUrl(ctx)}`
        : 'Общее пространство пары';
      return this.show(ctx, text, this.homeRows(ctx));
    }
    if (name === 'help') {
      return this.send(message, [
        '/task Купить билеты', '/backlog · /backlog без срока · /backlog октябрь 2026',
        '/day · /day 2026-11-22 · /major', '/month · /month 10 2026', '/year · /year 2026', '/review · /review октябрь · /review year 2026',
        '/invite в личном чате · /link в общем чате · /unlink',
      ].join('\n'));
    }
    const group = message.chat.type === 'group' || message.chat.type === 'supergroup';
    if (name === 'link' || name === 'start' && group && args === groupStart) {
      if (ctx.private) {
        if (ctx.space && ctx.space.groupChat !== null) return this.send(message, 'Общий чат уже подключён. Его можно отключить командой /unlink.');
        return this.show(ctx, 'Выберите группу пары. Ответы бота будут видны участникам группы.', [[this.groupButton()]]);
      }
      if (!group) return;
      if (!ctx.space) throw new InputError('Сначала откройте пространство командой /start в личном чате.');
      this.applyAction(ctx, () => this.store.linkGroup(ctx.space.id, message.chat.id));
      return this.send(message, 'Общий чат подключён. Ответы бота видны участникам этого чата.');
    }
    if (name === 'start' && group && ctx.space?.groupChat !== message.chat.id) {
      return this.send(message, `Чтобы подключить эту группу, участнику пространства нужно отправить /link@${this.username}.`);
    }
    if (name !== 'unlink' || !this.store.hasTelegramAction(ctx.updateId)) this.requireAccess(ctx);
    switch (name) {
      case 'start': return this.show(ctx, 'Общее пространство пары', this.homeRows(ctx));
      case 'invite':
        if (!ctx.private) return this.send(message, 'Ссылка-приглашение доступна в личном чате.');
        return this.send(message, ctx.space.invite ? this.inviteUrl(ctx) : 'Партнёр уже присоединился.');
      case 'unlink':
        this.applyAction(ctx, () => this.store.unlinkGroup(ctx.space.id));
        return this.send(message, 'Общий чат отключён.');
      case 'task': return args ? this.addTask(ctx, args) : this.promptForTask(ctx);
      case 'backlog': {
        const normalized = args.toLowerCase().replace(/\s+/g, ' ');
        const scope = !args ? 'all' : ['без месяца', 'без срока'].includes(normalized) ? 'none' : parseMonth(args, this.period);
        return this.showList(ctx, scope, 'active', 0);
      }
      case 'day': return this.showList(ctx, args ? exactDay(args) : currentDay(this.timeZone, this.now()), 'active', 0);
      case 'major': return this.showList(ctx, 'major', 'active', 0);
      case 'month': return this.showList(ctx, parseMonth(args, this.period), 'all', 0);
      case 'year': return this.showYear(ctx, parseYear(args || this.period.slice(0, 4)));
      case 'review': {
        const year = args.match(/^year(?:\s+(.+))?$/i);
        const scope = year ? parseYear(year[1] || this.period.slice(0, 4)) : parseMonth(args, this.period);
        return this.startReview(ctx, scope);
      }
    }
  }

  inviteUrl(ctx) {
    return `https://t.me/${this.username}?start=${ctx.space.invite}`;
  }

  async promptForTask(ctx) {
    if (this.store.hasTelegramAction(ctx.updateId)) return;
    const sent = await this.send(ctx.message, 'Ответьте на это сообщение названием задачи.', {
      force_reply: true,
      input_field_placeholder: 'Название задачи',
    });
    this.applyAction(ctx, () => this.store.setTaskPrompt(
      ctx.message.chat.id, ctx.user, sent.message_id, Date.now() + reviewLifetime));
  }

  async addTask(ctx, title, fromPrompt = false) {
    const space = ctx.space.id;
    const task = this.applyAction(ctx, () => {
      const created = this.store.createTask(space, ctx.user, { title }, `${ctx.message.chat.id}:${ctx.message.message_id}`);
      if (fromPrompt) this.store.clearTaskPrompt(ctx.message.chat.id, ctx.user);
      return created;
    });
    return this.send(ctx.message, `Добавлено: ${task.title}`, markup([
      taskActionButtons(task, 'all:active:0'),
      [button('Открыть задачу', `t2:all:active:0:${task.id}`), button('Бэклог', 'l:all:active:0')],
    ]));
  }

  async showList(ctx, scope, status, page) {
    const major = scope === 'major';
    const filterScope = major ? 'all' : parseScope(scope);
    let view = 'common';
    if (major) view = 'major';
    else if (filterScope.length === 7) view = 'month';
    else if (filterScope.length === 4 && filterScope !== 'none') view = 'year';
    const list = this.store.list(ctx.space.id, { scope: filterScope, status, view });
    const endPage = Math.max(0, Math.ceil(list.length / pageSize) - 1);
    const current = Math.min(endPage, Math.max(0, page || 0));
    const visible = list.slice(current * pageSize, (current + 1) * pageSize);
    const lines = [major ? 'Крупные задачи' : scope === 'all' ? 'Бэклог' : labelPeriod(scope === 'none' ? null : scope)];
    if (scope.length === 7) lines.push(statsLine(taskStats(this.store.list(ctx.space.id, { scope, view }))));
    const entities = [];
    let offset = lines.join('\n\n').length + 2;
    const taskLines = visible.map((task) => {
      const title = brief(task);
      if (task.status === 'done') entities.push(strike(title, offset));
      const line = task.status === 'obsolete' ? `Отменена · ${title}` : title;
      offset += line.length + 1;
      return line;
    });
    lines.push(taskLines.join('\n') || 'В этом списке пока нет задач.');
    if (endPage) lines.push(`Страница ${current + 1} из ${endPage + 1}`);
    if (visible.some((task) => task.status === 'active')) {
      lines.push('Нажмите на название задачи, чтобы завершить или отменить её.');
    }
    const rows = visible.map((task) =>
      [button(brief(task, 45), `t2:${scope}:${status}:${current}:${task.id}`)]);
    rows.push([
      ...(current > 0 ? [button('‹ Назад', `l:${scope}:${status}:${current - 1}`)] : []),
      ...(current < endPage ? [button('Дальше ›', `l:${scope}:${status}:${current + 1}`)] : []),
    ], Object.entries({ active: 'Активные', done: 'Выполненные', obsolete: 'Неактуальные', all: 'Все' })
      .map(([key, label]) => button(key === status ? `• ${label}` : label, `l:${scope}:${key}:0`)));
    if (scope.length === 7) {
      const previous = shiftMonth(scope, -1);
      const next = shiftMonth(scope, 1);
      rows.push([
        ...(previous ? [button('‹ Месяц', `l:${previous}:${status}:0`)] : []),
        button(scope.slice(0, 4), `y:${scope.slice(0, 4)}`),
        ...(next ? [button('Месяц ›', `l:${next}:${status}:0`)] : []),
      ], [button('Разобрать месяц', `r:${scope}`)]);
    }
    if (scope.length === 10) {
      const previous = shiftDay(scope, -1);
      const next = shiftDay(scope, 1);
      rows.push([
        ...(previous ? [button('‹ День', `l:${previous}:${status}:0`)] : []),
        ...(next ? [button('День ›', `l:${next}:${status}:0`)] : []),
      ]);
    }
    rows.push([
      button('Бэклог', `l:all:${status}:0`),
      button('Без срока', `l:none:${status}:0`),
      button('Текущий месяц', `l:${this.period}:${status}:0`),
    ], this.appButton(ctx.message));
    return this.show(ctx, lines.join('\n\n'), rows, entities);
  }

  async showYear(ctx, year) {
    parseYear(year);
    const list = this.store.list(ctx.space.id, { scope: year, view: 'statistics' });
    const lines = [`Итоги ${year}`, statsLine(taskStats(list))];
    const calendar = months.map((month, index) => {
      const period = `${year}-${String(index + 1).padStart(2, '0')}`;
      const stats = taskStats(list.filter((task) => task.period.startsWith(period)));
      if (stats.total) lines.push(`${month}: ${stats.done} выполнено, ${stats.active} активно, ${stats.obsolete} неактуально`);
      return button(month, `l:${period}:all:0`);
    });
    const rows = Array.from({ length: 4 }, (_, index) => calendar.slice(index * 3, index * 3 + 3));
    rows.push([
      ...(Number(year) > 1000 ? [button('‹ Пред. год', `y:${Number(year) - 1}`)] : []),
      button('Разобрать год', `r:${year}`),
      ...(Number(year) < 9999 ? [button('След. год ›', `y:${Number(year) + 1}`)] : []),
    ], [button('Задачи на год', `l:${year}:all:0`)], this.appButton(ctx.message));
    return this.show(ctx, lines.join('\n'), rows);
  }

  async showTask(ctx, task, scope, status, page) {
    const children = taskStats(this.store.children(ctx.space.id, task.id));
    const context = `${scope}:${status}:${page}`;
    const lines = [task.title, labelPeriod(task.period), `${importanceSymbols[task.importance]} ${importanceLevels[task.importance]}`];
    if (task.status === 'obsolete') lines.push('Отменена');
    if (task.parentTitle) lines.push(`Подзадача к «${task.parentTitle}»`);
    if (ctx.private && task.assigneeId) lines.push(task.assigneeId === ctx.user ? 'Назначена вам' : 'Назначена партнёру');
    if (children.total) {
      if (children.done + children.active) {
        lines.push(`Подзадачи: ${children.done} из ${children.done + children.active} выполнено · ${children.active} активно`);
      }
      if (children.obsolete) lines.push(`Неактуальных подзадач: ${children.obsolete}`);
    }
    if (task.category) {
      const category = this.store.catalog(ctx.space.id).categories.find(({ name }) => name === task.category);
      lines.push(`${categoryIcons[category?.icon || 'folder'][0]} ${task.category}`);
    }
    return this.show(ctx, lines.join('\n'), [
      taskActionButtons(task, context),
      children.total ? [button('Подзадачи', `k2:${context}:${task.id}`)] : [],
      this.appButton(ctx.message),
      [button('‹ К списку', `l:${context}`)],
    ], task.status === 'done' ? [strike(task.title)] : []);
  }

  async showChildren(ctx, id, context) {
    const parent = this.store.task(ctx.space.id, id);
    const children = this.store.children(ctx.space.id, id);
    return this.show(ctx, `Подзадачи · ${parent.title}`, [
      ...children.slice(0, 40).map((child) => [button(brief(child, 45), `t2:${context}:${child.id}`)]),
      this.appButton(ctx.message),
      [button('‹ К родительской задаче', `t2:${context}:${parent.id}`)],
    ]);
  }

  startReview(ctx, scope) {
    exactSchedule(scope);
    const key = randomBytes(6).toString('base64url');
    this.reviews.set(key, {
      scope, ids: this.store.list(ctx.space.id, { scope, status: 'active', view: 'statistics' }).map((task) => task.id),
      user: ctx.user, chat: ctx.message.chat.id, space: ctx.space.id, expires: Date.now() + reviewLifetime,
    });
    return this.showReview(ctx, key);
  }

  reviewTask(review) {
    while (review.ids.length) {
      const task = this.store.findTask(review.space, review.ids[0]);
      if (task && matches(task, review.scope)) return task;
      review.ids.shift();
    }
    return null;
  }

  async showReview(ctx, key, target = '') {
    const review = this.reviews.get(key);
    const scopeName = review.scope.length === 4 ? review.scope : labelPeriod(review.scope);
    const task = this.reviewTask(review);
    if (!task) {
      await this.show(ctx, `Разбор · ${scopeName}\n\nВ этом проходе задач больше нет.`, [
        [button('Повторить разбор', `r:${review.scope}`)],
        this.appButton(ctx.message),
      ]);
      this.reviews.delete(key);
      return;
    }
    const text = `Разбор · ${scopeName}\n\n${brief(task, 350)}\nОсталось в этом проходе: ${review.ids.length}`;
    const prefix = `a:${key}:${task.id}:${task.version}`;
    if (target) {
      exactSchedule(target);
      const steps = target.length === 10 ? [[-7, '‹ Нед.'], [-1, '‹ День'], [1, 'День ›'], [7, 'Нед. ›']]
        : target.length === 4 ? [[-1, '‹ Год'], [1, 'Год ›']]
          : [[-12, '‹ Год'], [-1, '‹ Месяц'], [1, 'Месяц ›'], [12, 'Год ›']];
      return this.show(ctx, `${text}\n\nПеренести в ${labelPeriod(target)}?`, [
        steps.map(([step, label]) => {
          const period = shiftSchedule(target, step);
          return period && button(label, `${prefix}:pick:${period}`);
        }).filter(Boolean),
        [button('Перенести', `${prefix}:move:${target}`), button('Убрать срок', `${prefix}:move:none`)],
        [button('‹ Назад', `${prefix}:back`)],
      ]);
    }
    return this.show(ctx, text, [
      [button('Перенести', `${prefix}:pick:${shiftSchedule(task.period, 1) ?? task.period}`)],
      [button(statusActions.done.label, `${prefix}:done`), button(statusActions.obsolete.label, `${prefix}:obsolete`),
        button('Оставить', `${prefix}:skip`)],
    ]);
  }

  async reviewAction(ctx, [key, id, version, action, target]) {
    const review = this.reviews.get(key);
    if (!review) throw new InputError('Этот разбор закрыт. Запустите /review ещё раз.');
    if (review.user !== ctx.user || review.chat !== ctx.message.chat.id || review.space !== ctx.space.id) {
      throw new InputError('Этот разбор начал партнёр. Запустите свой командой /review.');
    }
    const task = this.reviewTask(review);
    if (task?.id !== Number(id) || task.version !== Number(version)) {
      await this.showReview(ctx, key);
      return 'Список обновлён.';
    }
    if (action === 'pick') return void await this.showReview(ctx, key, exactSchedule(target));
    if (action === 'back') return void await this.showReview(ctx, key);
    try {
      if (action === 'move') {
        const period = target === 'none' ? null : exactSchedule(target);
        if (period === task.period) throw new InputError('Выберите другой срок или оставьте задачу.');
        this.applyAction(ctx, () => this.store.updateTask(review.space, task.id, { version: task.version, period }));
      } else if (action === 'done' || action === 'obsolete') {
        this.applyAction(ctx, () => this.store.updateTask(review.space, task.id, {
          version: task.version, status: action, confirmWithActiveSubtasks: target === 'yes',
        }));
      } else if (action !== 'skip') {
        throw new InputError('Действие недоступно.');
      }
    } catch (error) {
      if (error.status === 404) {
        await this.showReview(ctx, key);
        return 'Задача уже удалена. Список обновлён.';
      }
      if (!error.activeSubtasks) throw error;
      const prefix = `a:${key}:${task.id}:${version}`;
      await this.show(ctx, `${task.title}\n\n${activeSubtaskWarning(error.activeSubtasks)}`, [
        [button('Завершить всё равно', `${prefix}:done:yes`)],
        [button('К подзадачам', `k2:all:active:0:${task.id}`), button('‹ К разбору', `${prefix}:back`)],
      ]);
      return;
    }
    review.ids.shift();
    await this.showReview(ctx, key);
    return statusActions[action]?.notice ?? 'Готово';
  }

  async onButton(ctx, data) {
    const [action, ...parts] = data.split(':');
    const [scope, status, page, id, version, state] = parts;
    switch (action) {
      case 'add': await this.promptForTask(ctx); return;
      case 'join': {
        const source = Number(status);
        if (!ctx.private || !/^[A-Za-z0-9_-]{24}$/.test(scope) || !Number.isSafeInteger(source) || source < 1) {
          throw new InputError('Откройте приглашение ещё раз в личном чате с ботом.');
        }
        ctx.space = this.applyAction(ctx, () => this.store.joinOrCreate(ctx.user, scope, source));
        await this.show(ctx, 'Вы присоединились к партнёру. Ваши задачи теперь в общем бэклоге.', this.homeRows(ctx));
        return;
      }
      case 'stay': {
        if (!ctx.private) throw new InputError('Откройте личный чат с ботом.');
        await this.show(ctx, 'Вы остались в своём пространстве.', this.homeRows(ctx));
        return;
      }
      case 'l': await this.showList(ctx, scope, status, Number(page)); return;
      case 'y': await this.showYear(ctx, scope); return;
      case 'r': await this.startReview(ctx, scope); return;
      case 'a': return this.reviewAction(ctx, parts);
      case 't':
      case 'k':
      case 's':
        throw new InputError('Эта кнопка устарела. Откройте список заново командой /backlog.');
      case 't2': await this.showTask(ctx, this.store.task(ctx.space.id, Number(id)), scope, status, page); return;
      case 'k2': await this.showChildren(ctx, Number(id), `${scope}:${status}:${page}`); return;
      case 's2': {
        let task;
        try {
          task = this.applyAction(ctx, () => this.store.updateTask(ctx.space.id, Number(id), {
            version: Number(version), status: state, confirmWithActiveSubtasks: parts[6] === 'yes',
          }));
        } catch (error) {
          if (error.activeSubtasks) {
            const context = `${scope}:${status}:${page}`;
            const parent = this.store.task(ctx.space.id, Number(id));
            await this.show(ctx, `${parent.title}\n\n${activeSubtaskWarning(error.activeSubtasks)}`, [
              [button('Завершить всё равно', `s2:${context}:${id}:${version}:done:yes`)],
              [button('К подзадачам', `k2:${context}:${id}`), button('‹ Назад', `t2:${context}:${id}`)],
            ]);
            return;
          }
          if (error.status !== 409) throw error;
          await this.showTask(ctx, this.store.task(ctx.space.id, Number(id)), scope, status, page);
          return 'Задача уже изменилась.';
        }
        await this.showTask(ctx, this.store.task(ctx.space.id, task.id), scope, status, page);
        return statusActions[task.status].notice;
      }
      default: throw new InputError('Действие недоступно.');
    }
  }
}

async function processPendingUpdate(api, bot, update, signal, wait) {
  let attempts = 0;
  while (!signal.aborted) {
    try {
      await bot.handle(update);
      bot.store.finishTelegramUpdate(update.update_id);
      return;
    } catch (error) {
      if (signal.aborted) return;
      if (error.code === 401) throw error;
      attempts++;
      const sqliteCode = error.errcode & 0xff;
      const temporary = error.retryable || error.code === 408 || error.code === 429 || error.code >= 500
        || sqliteCode === 5 || sqliteCode === 6;
      const permanent = !temporary && (error.code === 400 || error.code === 403 || attempts >= 3);
      console.error(`Telegram, обновление ${update.update_id}, попытка ${attempts}:`, error.message);
      if (permanent) {
        const message = update.callback_query?.message ?? update.message;
        if (message && error.code !== 403) {
          await api.call('sendMessage', {
            chat_id: message.chat.id, text: 'Не удалось обработать команду. Проверьте изменения в бэклоге.',
          }, AbortSignal.any([signal, AbortSignal.timeout(10_000)])).catch((failure) => console.error(failure.message));
        }
        bot.store.finishTelegramUpdate(update.update_id, true);
        return;
      }
      await wait(error.retryAfter ?? Math.min(2 ** (attempts - 1), 30), signal);
    }
  }
}

export async function poll(api, bot, signal, wait = (seconds, stop) => setTimeout(seconds * 1000, undefined, { signal: stop })) {
  let offset = 0;
  let lastReceived = 0;
  while (!signal.aborted) {
    try {
      const pending = bot.store.pendingTelegramUpdate();
      if (pending) {
        await processPendingUpdate(api, bot, pending, signal, wait);
        continue;
      }
      if (Date.now() - lastReceived >= 86_400_000) offset = 0;
      const updates = await api.call('getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'callback_query'] },
        AbortSignal.any([signal, AbortSignal.timeout(40_000)]));
      if (updates.length) {
        bot.store.saveTelegramUpdates(updates);
        offset = updates.at(-1).update_id + 1;
        lastReceived = Date.now();
      }
    } catch (error) {
      if (signal.aborted) break;
      if (error.code === 401) throw error;
      console.error(error.message);
      const seconds = error.retryAfter ?? (error.code === 409 ? 15 : 3);
      await wait(seconds, signal).catch((failure) => {
        if (failure.name !== 'AbortError') throw failure;
      });
    }
  }
}

export function registerCommands(api) {
  return api.call('setMyCommands', {
    commands: Object.entries(commands).map(([command, description]) => ({ command, description })),
  });
}
