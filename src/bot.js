import { randomBytes } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { currentPeriod, exactPeriod, InputError, labelPeriod, months, parseMonth, parseScope, parseYear, shiftMonth } from './periods.js';
import { statuses, taskStats } from './store.js';
import { maxVoiceBytes, maxVoiceSeconds, tasksFromSpeech } from './voice.js';

const pageSize = 6;
const reviewLifetime = 30 * 60 * 1000;
const symbols = { active: '○', done: '✓', obsolete: '–' };
const statusActions = {
  active: { label: 'Вернуть в активные', notice: 'Задача снова активна.' },
  done: { label: 'Завершить', notice: 'Задача завершена.' },
  obsolete: { label: 'Отменить задачу', notice: 'Задача отменена. Она в списке «Неактуальные».' },
};
const commands = {
  start: 'Открыть пространство пары',
  task: 'Добавить задачу',
  backlog: 'Показать бэклог',
  month: 'Задачи месяца',
  year: 'Итоги года',
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
      throw new Error(`Ошибка соединения с Telegram при вызове ${method}.`);
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

function taskActionButtons(task, context) {
  return Object.entries(statusActions)
    .filter(([status]) => status !== task.status)
    .map(([status, { label }]) => button(label, `s:${context}:${task.id}:${task.version}:${status}`));
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

function matches(task, scope) {
  return task.status === 'active' && Boolean(task.period?.startsWith(scope));
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
    this.pending = new Map();
    this.reviews = new Map();
  }

  get period() {
    return currentPeriod(this.timeZone, this.now());
  }

  send(message, text, replyMarkup) {
    const request = { chat_id: message.chat.id, text, reply_markup: replyMarkup };
    if (message.message_thread_id) request.message_thread_id = message.message_thread_id;
    return this.api.call('sendMessage', request);
  }

  async show(ctx, text, rows = []) {
    if (!ctx.callback) return this.send(ctx.message, text, markup(rows));
    try {
      await this.api.call('editMessageText', {
        chat_id: ctx.message.chat.id,
        message_id: ctx.message.message_id,
        text,
        reply_markup: markup(rows),
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

  homeRows(message) {
    return [
      [button('＋ Добавить задачу', 'add'), button('Бэклог', 'l:all:active:0')],
      [button('Текущий месяц', `l:${this.period}:all:0`), button('Текущий год', `y:${this.period.slice(0, 4)}`)],
      this.appButton(message),
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
    if (message.migrate_to_chat_id) this.store.migrateGroup(message.chat.id, message.migrate_to_chat_id);
    if (message.migrate_from_chat_id) this.store.migrateGroup(message.migrate_from_chat_id, message.chat.id);
    if (!user || user.is_bot) return;

    for (const cache of [this.pending, this.reviews]) {
      for (const [id, value] of cache) if (value.expires <= Date.now()) cache.delete(id);
    }
    const ctx = { callback, message, user: user.id, private: message.chat.type === 'private', space: this.store.spaceFor(user.id) };
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
          .catch((error) => { if (error.code !== 400) throw error; });
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
    const key = `${message.chat.id}:${ctx.user}`;
    const prompt = this.pending.get(key);
    const isReply = prompt && message.reply_to_message?.message_id === prompt.messageId;
    if (!command && !isReply) return;

    try {
      if (command) await this.onCommand(ctx, command.name, command.args);
      else {
        this.requireAccess(ctx);
        await this.addTask(ctx, message.text);
        this.pending.delete(key);
      }
    } catch (error) {
      if (!(error instanceof InputError)) throw error;
      await this.send(message, error.message);
    }
  }

  queueVoice(ctx) {
    const { voice, message_id: messageId, chat } = ctx.message;
    if (voice.duration > maxVoiceSeconds) {
      throw new InputError('Отправьте голосовое длительностью до 90 секунд.');
    }
    if (voice.file_size > maxVoiceBytes) {
      throw new InputError('Запись слишком большая. Отправьте её двумя частями.');
    }
    this.store.queueVoice(ctx.space.id, ctx.user, chat.id, messageId, voice.file_id);
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
      button(tasks.length === 1 ? 'Открыть задачу' : brief(task, 45), `t:${context}:${task.id}`),
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
      ctx.space = this.store.joinOrCreate(user, args === 'app' ? '' : args);
      const text = ctx.space.invite
        ? `Ваше пространство готово. Пригласите партнёра по ссылке:\n${this.inviteUrl(ctx)}`
        : 'Общее пространство пары';
      return this.show(ctx, text, this.homeRows(message));
    }
    if (name === 'help') {
      return this.send(message, [
        '/task Купить билеты', '/backlog · /backlog без месяца · /backlog октябрь 2026',
        '/month · /month 10 2026', '/year · /year 2026', '/review · /review октябрь · /review year 2026',
        '/invite в личном чате · /link в общем чате · /unlink',
      ].join('\n'));
    }
    if (name === 'link') {
      if (ctx.private) return this.send(message, 'Добавьте бота в общий чат пары и отправьте там /link.');
      if (!ctx.space) throw new InputError('Сначала откройте пространство командой /start в личном чате.');
      this.store.linkGroup(ctx.space.id, message.chat.id);
      return this.send(message, 'Общий чат подключён. Ответы бота видны участникам этого чата.');
    }
    this.requireAccess(ctx);
    switch (name) {
      case 'start': return this.show(ctx, 'Общее пространство пары', this.homeRows(message));
      case 'invite':
        if (!ctx.private) return this.send(message, 'Ссылка-приглашение доступна в личном чате.');
        return this.send(message, ctx.space.invite ? this.inviteUrl(ctx) : 'Партнёр уже присоединился.');
      case 'unlink':
        this.store.unlinkGroup(ctx.space.id);
        return this.send(message, 'Общий чат отключён.');
      case 'task': return args ? this.addTask(ctx, args) : this.promptForTask(ctx);
      case 'backlog': {
        const normalized = args.toLowerCase().replace(/\s+/g, ' ');
        const scope = !args ? 'all' : normalized === 'без месяца' ? 'none' : parseMonth(args, this.period);
        return this.showList(ctx, scope, 'active', 0);
      }
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
    const sent = await this.send(ctx.message, 'Ответьте на это сообщение названием задачи.', {
      force_reply: true,
      input_field_placeholder: 'Название задачи',
    });
    this.pending.set(`${ctx.message.chat.id}:${ctx.user}`, {
      messageId: sent.message_id,
      expires: Date.now() + reviewLifetime,
    });
  }

  async addTask(ctx, title) {
    const space = ctx.space.id;
    const task = this.store.createTask(space, ctx.user, { title }, `${ctx.message.chat.id}:${ctx.message.message_id}`);
    return this.send(ctx.message, `Добавлено: ${task.title}`, markup([
      taskActionButtons(task, 'all:active:0'),
      [button('Открыть задачу', `t:all:active:0:${task.id}`), button('Бэклог', 'l:all:active:0')],
    ]));
  }

  async showList(ctx, scope, status, page) {
    parseScope(scope);
    const list = this.store.list(ctx.space.id, { scope, status });
    const endPage = Math.max(0, Math.ceil(list.length / pageSize) - 1);
    const current = Math.min(endPage, Math.max(0, page || 0));
    const visible = list.slice(current * pageSize, (current + 1) * pageSize);
    const lines = [scope === 'all' ? 'Бэклог' : labelPeriod(scope === 'none' ? null : scope)];
    if (scope.length === 7) lines.push(statsLine(taskStats(this.store.list(ctx.space.id, { scope }))));
    lines.push(visible.length ? visible.map((task) => `${symbols[task.status]} ${brief(task)}`).join('\n') : 'В этом списке пока нет задач.');
    if (endPage) lines.push(`Страница ${current + 1} из ${endPage + 1}`);
    if (visible.some((task) => task.status === 'active')) {
      lines.push('Нажмите на название задачи, чтобы завершить или отменить её.');
    }
    const rows = visible.map((task) =>
      [button(`${symbols[task.status]} ${brief(task, 45)}`, `t:${scope}:${status}:${current}:${task.id}`)]);
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
    rows.push([
      button('Все месяцы', `l:all:${status}:0`),
      button('Без месяца', `l:none:${status}:0`),
      button('Текущий месяц', `l:${this.period}:${status}:0`),
    ], this.appButton(ctx.message));
    return this.show(ctx, lines.join('\n\n'), rows);
  }

  async showYear(ctx, year) {
    parseYear(year);
    const list = this.store.list(ctx.space.id, { scope: year });
    const lines = [`Итоги ${year}`, statsLine(taskStats(list))];
    const calendar = months.map((month, index) => {
      const period = `${year}-${String(index + 1).padStart(2, '0')}`;
      const stats = taskStats(list.filter((task) => task.period === period));
      if (stats.total) lines.push(`${month}: ${stats.done} выполнено, ${stats.active} активно, ${stats.obsolete} неактуально`);
      return button(month, `l:${period}:all:0`);
    });
    const rows = Array.from({ length: 4 }, (_, index) => calendar.slice(index * 3, index * 3 + 3));
    rows.push([
      ...(Number(year) > 1000 ? [button('‹ Пред. год', `y:${Number(year) - 1}`)] : []),
      button('Разобрать год', `r:${year}`),
      ...(Number(year) < 9999 ? [button('След. год ›', `y:${Number(year) + 1}`)] : []),
    ], this.appButton(ctx.message));
    return this.show(ctx, lines.join('\n'), rows);
  }

  async showTask(ctx, task, scope, status, page) {
    const children = taskStats(this.store.children(ctx.space.id, task.id));
    const context = `${scope}:${status}:${page}`;
    const lines = [task.title, `${statuses[task.status]} · ${labelPeriod(task.period)}`];
    if (task.parentTitle) lines.push(`Подзадача к «${task.parentTitle}»`);
    if (children.total) {
      if (children.done + children.active) {
        lines.push(`Подзадачи: ${children.done} из ${children.done + children.active} выполнено · ${children.active} активно`);
      }
      if (children.obsolete) lines.push(`Неактуальных подзадач: ${children.obsolete}`);
    }
    if (task.category) lines.push(task.category);
    if (task.tags.length) lines.push(task.tags.join(', '));
    return this.show(ctx, lines.join('\n'), [
      taskActionButtons(task, context),
      this.appButton(ctx.message),
      [button('‹ К списку', `l:${context}`)],
    ]);
  }

  startReview(ctx, scope) {
    if (scope.length === 4) parseYear(scope);
    else exactPeriod(scope);
    const key = randomBytes(6).toString('base64url');
    this.reviews.set(key, {
      scope, ids: this.store.list(ctx.space.id, { scope, status: 'active' }).map((task) => task.id),
      user: ctx.user, chat: ctx.message.chat.id, space: ctx.space.id, expires: Date.now() + reviewLifetime,
    });
    return this.showReview(ctx, key);
  }

  reviewTask(review) {
    while (review.ids.length) {
      const task = this.store.task(review.space, review.ids[0]);
      if (matches(task, review.scope)) return task;
      review.ids.shift();
    }
    return null;
  }

  async showReview(ctx, key, target = '') {
    const review = this.reviews.get(key);
    const scopeName = review.scope.length === 4 ? review.scope : labelPeriod(review.scope);
    const task = this.reviewTask(review);
    if (!task) {
      this.reviews.delete(key);
      return this.show(ctx, `Разбор · ${scopeName}\n\nВ этом проходе задач больше нет.`, [
        [button('Повторить разбор', `r:${review.scope}`)],
        this.appButton(ctx.message),
      ]);
    }
    const text = `Разбор · ${scopeName}\n\n${brief(task, 350)}\nОсталось в этом проходе: ${review.ids.length}`;
    const prefix = `a:${key}:${task.id}:${task.version}`;
    if (target) {
      exactPeriod(target);
      return this.show(ctx, `${text}\n\nПеренести в ${labelPeriod(target)}?`, [
        [-12, -1, 1, 12].map((step, index) => {
          const period = shiftMonth(target, step);
          return period && button(['‹ Год', '‹ Месяц', 'Месяц ›', 'Год ›'][index], `${prefix}:pick:${period}`);
        }).filter(Boolean),
        [button('Перенести', `${prefix}:move:${target}`), button('Убрать месяц', `${prefix}:move:none`)],
        [button('‹ Назад', `${prefix}:back`)],
      ]);
    }
    return this.show(ctx, text, [
      [button('Перенести', `${prefix}:pick:${shiftMonth(task.period, 1) ?? task.period}`),
        button(statusActions.obsolete.label, `${prefix}:obsolete`)],
      [button(statusActions.done.label, `${prefix}:done`), button('Оставить', `${prefix}:skip`)],
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
    if (action === 'pick') return void await this.showReview(ctx, key, exactPeriod(target));
    if (action === 'back') return void await this.showReview(ctx, key);
    if (action === 'move') {
      const period = target === 'none' ? null : exactPeriod(target);
      if (period === task.period) throw new InputError('Выберите другой месяц или оставьте задачу.');
      this.store.updateTask(review.space, task.id, { version: task.version, period });
    } else if (action === 'done' || action === 'obsolete') {
      this.store.updateTask(review.space, task.id, { version: task.version, status: action });
    } else if (action !== 'skip') {
      throw new InputError('Действие недоступно.');
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
      case 'l': await this.showList(ctx, scope, status, Number(page)); return;
      case 'y': await this.showYear(ctx, scope); return;
      case 'r': await this.startReview(ctx, scope); return;
      case 'a': return this.reviewAction(ctx, parts);
      case 't': await this.showTask(ctx, this.store.task(ctx.space.id, Number(id)), scope, status, page); return;
      case 's': {
        let task;
        try {
          task = this.store.updateTask(ctx.space.id, Number(id), { version: Number(version), status: state });
        } catch (error) {
          if (error.status !== 409) throw error;
          await this.showTask(ctx, this.store.task(ctx.space.id, Number(id)), scope, status, page);
          return 'Задача уже изменилась.';
        }
        await this.showTask(ctx, task, scope, status, page);
        return statusActions[task.status].notice;
      }
      default: throw new InputError('Действие недоступно.');
    }
  }
}

export async function poll(api, bot, signal) {
  let offset = 0;
  while (!signal.aborted) {
    try {
      const updates = await api.call('getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'callback_query'] },
        AbortSignal.any([signal, AbortSignal.timeout(40_000)]));
      for (const update of updates) {
        if (signal.aborted) break;
        try {
          await bot.handle(update);
        } catch (error) {
          console.error('Обновление Telegram:', error.message);
        }
        offset = update.update_id + 1;
      }
    } catch (error) {
      if (signal.aborted) break;
      if (error.code === 401) throw error;
      console.error(error.message);
      const seconds = error.retryAfter ?? (error.code === 409 ? 15 : 3);
      await setTimeout(seconds * 1000, undefined, { signal }).catch((failure) => {
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
