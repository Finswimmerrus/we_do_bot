import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Bot, poll } from '../src/bot.js';
import { currentPeriod, exactDay, parseMonth, shiftDay } from '../src/periods.js';
import { Store, taskStats } from '../src/store.js';
import { webServer } from '../src/web.js';

const token = '12345:local-test-token';
const group = { id: -10012345, type: 'supergroup' };

function setup(t) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const requests = [];
  let messageId = 10;
  const api = {
    async call(method, data) {
      requests.push({ method, data });
      return { message_id: ++messageId };
    },
  };
  const bot = new Bot({
    api, store, username: 'test_bot', timeZone: 'Europe/Moscow', appUrl: 'https://example.test/',
    now: () => new Date('2026-11-22T12:00:00Z'),
  });
  const receive = (user, text, chat = { id: user, type: 'private' }, replyTo = null) => {
    const message = { message_id: ++messageId, chat, from: { id: user, first_name: `Имя ${user}` }, text };
    if (text.startsWith('/')) message.entities = [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }];
    if (replyTo) message.reply_to_message = { message_id: replyTo };
    return bot.handle({ message });
  };
  const click = (user, data, chat = { id: user, type: 'private' }) => bot.handle({
    callback_query: { id: 'callback', data, from: { id: user }, message: { message_id: 9, chat } },
  });
  const last = (method) => requests.findLast((request) => request.method === method).data;
  return { store, requests, receive, click, last, latestMessageId: () => messageId };
}

function signed(user, authDate = Math.floor(Date.now() / 1000)) {
  const fields = {
    auth_date: String(authDate),
    query_id: 'AAE_123',
    signature: 'sample-telegram-signature',
    user: JSON.stringify({ id: user, first_name: 'Тест' }),
  };
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = createHmac('sha256', secret)
    .update(Object.keys(fields).sort().map((key) => `${key}=${fields[key]}`).join('\n')).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

test('текущий, предыдущий и ближайший будущий месяц', () => {
  assert.equal(currentPeriod('Europe/Moscow', new Date('2026-10-31T22:30:00Z')), '2026-11');
  const examples = {
    '': '2026-11', ноябрь: '2026-11', октябрь: '2026-10', сентябрь: '2027-09',
    декабрь: '2026-12', январь: '2027-01', '10 2026': '2026-10', 'октября 2025': '2025-10',
  };
  for (const [input, expected] of Object.entries(examples)) assert.equal(parseMonth(input, '2026-11'), expected);
  assert.equal(parseMonth('декабрь', '2027-01'), '2026-12');
  assert.equal(parseMonth('ноябрь', '2027-01'), '2027-11');
  assert.throws(() => parseMonth('13 2026', '2026-11'));
  assert.equal(shiftDay('2026-12-31', 1), '2027-01-01');
  assert.equal(shiftDay('2028-02-28', 1), '2028-02-29');
  assert.throws(() => exactDay('2026-02-29'));
});

test('личный и связанный общий чаты используют один бэклог пары', async (t) => {
  const { store, receive, click, last, requests, latestMessageId } = setup(t);
  await receive(11, '/start');
  const initial = store.spaceFor(11);
  assert.match(last('sendMessage').text, new RegExp(initial.invite));
  const addToGroup = last('sendMessage').reply_markup.inline_keyboard.flat()
    .find(({ text }) => text === 'Добавить бота в группу');
  assert.equal(addToGroup.url, 'https://t.me/test_bot?startgroup=pair-chat');
  await receive(22, `/start ${initial.invite}`);
  assert.equal(store.spaceFor(22).id, initial.id);
  await receive(33, `/start ${initial.invite}`);
  assert.equal(store.spaceFor(33), null);
  await receive(33, '/start@test_bot pair-chat', group);
  assert.equal(store.spaceFor(11).groupChat, null);
  await receive(11, '/start@test_bot pair-chat', group);
  assert.match(last('sendMessage').text, /Общий чат подключён/);
  await receive(22, '/start@test_bot pair-chat', { ...group, id: group.id - 1 });
  assert.match(last('sendMessage').text, /\/unlink/);
  await receive(11, '/link@test_bot', group);
  assert.equal(store.spaceFor(22).groupChat, group.id);
  await receive(11, '/task Купить билеты');
  await receive(22, '/task Купить полотенца', group);
  await receive(33, '/task Чужая задача', group);
  await receive(22, 'Обычная переписка', group);
  await receive(22, '/task@some_other_bot Не наша команда', group);
  assert.equal(store.list(initial.id).length, 2);

  await click(22, 'add', group);
  const prompt = requests.findLast(({ data }) => data.reply_markup?.force_reply);
  assert.ok(prompt);
  const promptId = latestMessageId() - 1;
  await receive(11, 'Чужой ответ на приглашение', group, promptId);
  await receive(22, 'Ответ на приглашение', group, promptId);
  assert.equal(store.list(initial.id).length, 3);
  await receive(11, '/backlog');
  const detail = last('sendMessage').reply_markup.inline_keyboard[0][0].callback_data;
  await click(11, detail);
  const complete = last('editMessageText').reply_markup.inline_keyboard[0][0].callback_data;
  await click(11, complete);
  assert.equal(store.list(initial.id, { status: 'done' }).length, 1);
  assert.ok(store.list(initial.id, { status: 'done' })[0].completedAt);
  const completed = last('editMessageText');
  assert.deepEqual(completed.entities, [{ type: 'strikethrough', offset: 0, length: 'Ответ на приглашение'.length }]);

  await receive(11, '/task Уточнить время встречи');
  const newTask = last('sendMessage').reply_markup.inline_keyboard[0];
  assert.deepEqual(newTask.map(({ text }) => text), ['✓', '🗑']);
  await click(11, newTask[1].callback_data);
  assert.equal(store.list(initial.id, { status: 'obsolete' })[0].title, 'Уточнить время встречи');
  const restore = last('editMessageText').reply_markup.inline_keyboard[0][0];
  assert.equal(restore.text, 'Вернуть в активные');
  await click(11, restore.callback_data);
  assert.equal(store.list(initial.id, { status: 'obsolete' }).length, 0);
});

test('разбор сохраняет точные периоды и отклоняет устаревшие действия', async (t) => {
  const { store, receive, click, last } = setup(t);
  await receive(11, '/start');
  const space = store.spaceFor(11).id;
  const task = store.createTask(space, 11, { title: 'Купить билеты' });
  store.updateTask(space, task.id, { version: task.version, period: '2026-10' });
  await receive(11, '/review year 2026');
  const options = last('sendMessage').reply_markup.inline_keyboard;
  store.updateTask(space, task.id, { version: 2, title: 'Купить два билета' });
  await click(11, options[1][0].callback_data);
  assert.equal(store.task(space, task.id).status, 'active');
  assert.match(last('editMessageText').text, /Купить два билета/);
  const pick = last('editMessageText').reply_markup.inline_keyboard[0][0].callback_data;
  await click(11, pick);
  const move = last('editMessageText').reply_markup.inline_keyboard[1][0].callback_data;
  await click(11, move);
  assert.equal(store.task(space, task.id).period, '2026-11');
  assert.match(last('editMessageText').text, /задач больше нет/);
  await receive(11, '/review year 2026');
  assert.match(last('sendMessage').text, /Купить два билета/);
});

test('удаление подзадачи не передаёт её номер новой задаче и не оживляет старые кнопки', async (t) => {
  const { store, receive, click, last } = setup(t);
  await receive(11, '/start');
  const { id: space } = store.spaceFor(11);
  const parent = store.createTask(space, 11, { title: 'Ремонт' });
  const old = store.createTask(space, 11, { title: 'Купить краску', parentId: parent.id });
  await receive(11, '/backlog');
  const open = last('sendMessage').reply_markup.inline_keyboard.flat().find(({ text }) => text.startsWith(old.title));
  await click(11, open.callback_data);
  const complete = last('editMessageText').reply_markup.inline_keyboard[0][0].callback_data;
  store.deleteSubtask(space, old.id, old.version);
  const replacement = store.createTask(space, 11, { title: 'Другая задача' });
  assert.ok(replacement.id > old.id);

  await click(11, complete);
  assert.match(last('answerCallbackQuery').text, /Задача не найдена/);
  await click(11, `s:all:active:0:${replacement.id}:${replacement.version}:obsolete`);
  assert.match(last('answerCallbackQuery').text, /кнопка устарела/);
  assert.equal(store.task(space, replacement.id).status, 'active');
});

test('разбор пропускает удалённую подзадачу, сохраняя следующую без изменений', async (t) => {
  const { store, receive, click, last } = setup(t);
  await receive(11, '/start');
  const { id: space } = store.spaceFor(11);
  const next = store.createTask(space, 11, { title: 'Следующая задача', period: '2026-11' });
  for (const action of ['Оставить', '✓', 'Перенести']) {
    const current = store.createTask(space, 11, { title: 'Удаляемая подзадача', parentId: next.id, period: next.period });
    await receive(11, '/review');
    assert.match(last('sendMessage').text, /Удаляемая подзадача/);
    let choice = last('sendMessage').reply_markup.inline_keyboard.flat().find(({ text }) => text === action);
    if (action === 'Перенести') {
      await click(11, choice.callback_data);
      choice = last('editMessageText').reply_markup.inline_keyboard.flat().find(({ text }) => text === 'Перенести');
    }
    store.deleteSubtask(space, current.id, current.version);
    await click(11, choice.callback_data);
    assert.match(last('editMessageText').text, /Следующая задача/);
    assert.match(last('answerCallbackQuery').text, /Список обновлён/);
    assert.deepEqual(store.task(space, next.id), next);
  }
});

test('повторное приглашение переносит чужое одиночное пространство только после подтверждения', async (t) => {
  const { store, receive, click, last } = setup(t);
  await receive(11, '/start');
  await receive(22, '/start');
  const first = store.spaceFor(11);
  const second = store.spaceFor(22);
  store.linkGroup(second.id, -100123);
  const category = store.createLabel(first.id, { kind: 'category', name: 'Дом' });
  const oldTask = store.createTask(second.id, 22, { title: 'Ремонт', category: 'дом', period: '2026-12' });
  const child = store.createTask(second.id, 22, { title: 'Купить краску', parentId: oldTask.id });
  store.queueVoice(second.id, 22, 22, 44, 'queued');
  const queued = store.pendingVoice();
  await receive(22, `/start ${first.invite}`);
  const prompt = last('sendMessage');
  assert.match(prompt.text, /\(2\)/);
  assert.match(prompt.text, /общий чат будет отключён/);
  assert.equal(store.spaceFor(22).id, second.id);
  await click(22, prompt.reply_markup.inline_keyboard[1][0].callback_data);
  assert.equal(store.spaceFor(22).id, second.id);
  await receive(22, `/start ${first.invite}`);
  const confirm = last('sendMessage').reply_markup.inline_keyboard[0][0].callback_data;
  await click(22, confirm);
  assert.equal(store.spaceFor(22).id, first.id);
  assert.equal(store.task(first.id, child.id).parentId, oldTask.id);
  assert.equal(store.task(first.id, child.id).category, 'Дом');
  assert.equal(store.task(first.id, oldTask.id).period, '2026-12');
  assert.deepEqual(store.catalog(first.id).categories.map(({ id }) => id), [category.id]);
  store.completeVoice(queued, ['Задача из голоса']);
  assert.equal(store.list(first.id).length, 3);
  await click(22, confirm);
  assert.equal(store.list(first.id).length, 3);
  await receive(33, `/start ${second.invite}`);
  assert.equal(store.spaceFor(33), null);
  await receive(33, '/start');
  await receive(22, `/start ${store.spaceFor(33).invite}`);
  assert.match(last('sendMessage').text, /уже в пространстве/);
  assert.equal(store.spaceFor(22).id, first.id);
  assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('неподтверждённое обновление сохраняется при перезапуске и не дублирует созданную задачу', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'we-do-telegram-'));
  const path = join(directory, 'tasks.sqlite');
  let store = new Store(path);
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true });
  });
  const { id: space } = store.joinOrCreate(11);
  const update = (id, title) => ({
    update_id: id,
    message: { message_id: id, chat: { id: 11, type: 'private' }, from: { id: 11 },
      text: '/task ' + title, entities: [{ type: 'bot_command', offset: 0, length: 5 }] },
  });
  const updates = [update(71, 'Первая'), update(72, 'Вторая')];
  const stopFirst = new AbortController();
  const first = {
    async call(method) {
      if (method === 'getUpdates') return updates;
      stopFirst.abort();
      throw new Error('connection lost after task creation');
    },
  };
  const options = { username: 'test_bot', timeZone: 'Europe/Moscow' };
  await poll(first, new Bot({ ...options, store, api: first }), stopFirst.signal);
  store.close();
  store = new Store(path);
  assert.equal(store.pendingTelegramUpdate().update_id, 71);
  assert.ok(store.hasTelegramAction(71));
  assert.equal(store.list(space).length, 1);

  const stopSecond = new AbortController();
  const notices = [];
  const offsets = [];
  const delays = [];
  let retry = true;
  const second = {
    async call(method, body) {
      if (method === 'getUpdates') {
        offsets.push(body.offset);
        if (offsets.length === 1) return updates;
        stopSecond.abort();
        return [];
      }
      if (retry) {
        retry = false;
        throw Object.assign(new Error('rate limited'), { code: 429, retryAfter: 2 });
      }
      notices.push(body.text);
    },
  };
  await poll(second, new Bot({ ...options, store, api: second }), stopSecond.signal, async (delay) => delays.push(delay));
  assert.deepEqual(delays, [2]);
  assert.deepEqual(offsets, [0, 73]);
  assert.deepEqual(notices, ['Добавлено: Первая', 'Добавлено: Вторая']);
  assert.equal(store.pendingTelegramUpdate(), null);
  assert.equal(store.list(space).length, 2);
});

test('каталог переносит старые категории и теги и сохраняет его после перезапуска', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'we-do-labels-'));
  const path = join(directory, 'tasks.sqlite');
  const previous = new Store(path);
  const { id: space } = previous.joinOrCreate(11);
  const first = previous.createTask(space, 11, { title: 'Первая' });
  const second = previous.createTask(space, 11, { title: 'Вторая' });
  const seed = previous.db.prepare('UPDATE tasks SET category = ?, tags = ? WHERE id = ?');
  seed.run('Мелкие', '["Дом"]', first.id);
  seed.run('мелкие', '["дом", "Покупки"]', second.id);
  previous.db.exec('ALTER TABLE tasks DROP COLUMN importance; ALTER TABLE labels DROP COLUMN icon; PRAGMA user_version = 0');
  previous.close();

  const store = new Store(path);
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true });
  });
  const { categories, tags } = store.catalog(space);
  assert.deepEqual(categories.map(({ name }) => name), ['Мелкие']);
  assert.deepEqual(tags.map(({ name }) => name), ['Дом', 'Покупки']);
  assert.deepEqual(store.task(space, second.id).tags, ['Дом', 'Покупки']);
  assert.equal(store.task(space, second.id).category, 'Мелкие');
  assert.equal(store.task(space, second.id).version, second.version + 1);
  store.deleteLabel(space, tags[0].id);
  assert.deepEqual(store.task(space, second.id).tags, ['Покупки']);
  const reopened = new Store(path);
  try {
    assert.deepEqual(reopened.catalog(space).tags.map(({ name }) => name), ['Покупки']);
    assert.equal(reopened.task(space, first.id).title, 'Первая');
  } finally {
    reopened.close();
  }
});

test('переход со схемы 2 сохраняет собственный месяц и заполняет отсутствующую категорию один раз', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'we-do-subtasks-'));
  const path = join(directory, 'tasks.sqlite');
  const old = new Store(path);
  const { id: space } = old.joinOrCreate(11);
  const parent = old.createTask(space, 11, { title: 'Поездка', category: 'Отдых', period: '2026-11' });
  const child = old.createTask(space, 11, { title: 'Забронировать отель', parentId: parent.id, period: '2026-10', categoryChoice: null });
  const childWithoutMonth = old.createTask(space, 11, { title: 'Купить билеты', parentId: parent.id, category: 'Билеты' });
  old.db.exec('PRAGMA user_version = 2');
  old.close();

  const store = new Store(path);
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true });
  });
  assert.equal(store.task(space, child.id).category, 'Отдых');
  assert.equal(store.task(space, child.id).period, '2026-10');
  assert.equal(store.task(space, childWithoutMonth.id).period, null);
  assert.equal(store.task(space, childWithoutMonth.id).category, 'Билеты');
  store.updateTask(space, parent.id, { version: parent.version, category: 'Другое', period: '2026-12' });
  assert.equal(store.task(space, child.id).category, 'Отдых');
  assert.equal(store.task(space, child.id).period, '2026-10');
});

test('перенос базы со схемы 3 сохраняет связи и запоминает удалённый максимум после перезапуска', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'we-do-task-ids-'));
  const path = join(directory, 'tasks.sqlite');
  let store = new Store(path);
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true });
  });
  const { id: space } = store.joinOrCreate(11);
  const parent = store.createTask(space, 11, { title: 'Родитель', category: 'Поездки' }, 'source-parent');
  const child = store.createTask(space, 11, { title: 'Подзадача', parentId: parent.id, period: '2026-11' });
  const { sql } = store.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'tasks'").get();
  const legacy = sql.replace('CREATE TABLE tasks', 'CREATE TABLE legacy_tasks')
    .replace('PRIMARY KEY AUTOINCREMENT', 'PRIMARY KEY')
    .replace('REFERENCES tasks(', 'REFERENCES legacy_tasks(');
  store.db.exec(`
    PRAGMA foreign_keys = OFF;
    ${legacy};
    INSERT INTO legacy_tasks SELECT * FROM tasks;
    DROP TABLE tasks;
    ALTER TABLE legacy_tasks RENAME TO tasks;
    PRAGMA user_version = 3;
  `);
  store.close();

  store = new Store(path);
  assert.deepEqual(store.task(space, parent.id), parent);
  assert.deepEqual(store.children(space, parent.id), [child]);
  assert.equal(store.createTask(space, 11, { title: 'Повтор запроса' }, 'source-parent').id, parent.id);
  assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(), []);
  store.deleteSubtask(space, child.id, child.version);
  store.close();

  store = new Store(path);
  const replacement = store.createTask(space, 11, { title: 'Новая задача' });
  assert.ok(replacement.id > child.id);
});

test('Mini App копирует категорию при создании и сохраняет свой период подзадачи', async (t) => {
  const { store, receive, click, last } = setup(t);
  await receive(11, '/start');
  await receive(22, `/start ${store.spaceFor(11).invite}`);
  await receive(33, '/start');
  await receive(11, '/task Поездка');
  const server = webServer({ store, token, username: 'test_bot', timeZone: 'Europe/Moscow' });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const auth = signed(22);
  const call = async (path, { initData = auth, method = 'GET', body } = {}) => {
    const response = await fetch(`${origin}/api/${path}`, {
      method, body: JSON.stringify(body),
      headers: { 'x-telegram-init-data': initData, 'content-type': 'application/json' },
    });
    return { code: response.status, data: await response.json() };
  };
  assert.equal((await call('session', { initData: '' })).code, 401);
  assert.equal((await call('session', { initData: signed(22, 123) })).code, 401);
  assert.equal((await call('session', { initData: auth.replace('22', '33') })).code, 401);
  const { data: { tasks: [parent] } } = await call('tasks');
  assert.equal(parent.title, 'Поездка');
  assert.equal((await call(`tasks/${parent.id}`, { initData: signed(33) })).code, 404);

  const patch = (task, data) => call(`tasks/${task.id}`, { method: 'PATCH', body: { version: task.version, ...data } });
  const { data: { task: plannedParent } } = await patch(parent, { period: '2026-10', category: 'Быт', importance: 'global' });
  assert.equal(parent.description, '');
  const { code, data: { task: child } } = await call('tasks', {
    method: 'POST', body: { title: 'Билеты', description: 'Поезд\nДва билета', parentId: parent.id },
  });
  assert.equal(code, 201);
  assert.equal(child.period, null);
  assert.equal(child.category, 'Быт');
  assert.equal(child.description, 'Поезд\nДва билета');
  assert.equal((await patch(child, { description: 'я'.repeat(2001) })).code, 400);
  assert.equal((await call('tasks', { method: 'POST', body: { title: 'Ещё уровень', parentId: child.id } })).code, 400);
  assert.equal((await patch(plannedParent, { parentId: child.id })).code, 400);
  assert.equal((await patch(child, { importance: 'global' })).code, 400);
  const { data: { task: plannedChild } } = await patch(child, { description: 'На двоих', period: '2026-10', tags: ['Дом', 'дом'], importance: 'high' });
  assert.equal(plannedChild.period, '2026-10');
  assert.equal((await call(`tasks/${child.id}`)).data.task.description, 'На двоих');
  assert.equal(plannedChild.category, 'Быт');
  assert.equal(plannedChild.importance, 'high');
  const completion = { period: '2026-11', category: 'Поездки', status: 'done' };
  const warning = await patch(plannedParent, completion);
  assert.equal(warning.code, 422);
  assert.equal(warning.data.activeSubtasks, 1);
  assert.equal(store.task(store.spaceFor(11).id, parent.id).status, 'active');
  assert.equal((await patch(plannedParent, { ...completion, confirmWithActiveSubtasks: true })).code, 200);
  assert.equal((await patch(parent, { status: 'obsolete' })).code, 409);
  const { data } = await call('tasks?scope=2026&include=summary');
  assert.equal(data.monthStats['2026-10'].active, 1);
  assert.equal(data.monthStats['2026-11'].active, 0);
  assert.equal(data.monthStats['2026-11'].done, 1);
  const savedChild = data.tasks.find((task) => task.id === child.id);
  assert.deepEqual(savedChild.tags, ['дом']);
  assert.equal(savedChild.category, 'Быт');
  assert.equal(data.stats.percent, 50);
  assert.equal(taskStats([{ status: 'obsolete' }]).percent, null);
  const { data: { tasks: filtered } } = await call('tasks?scope=2026-10&importance=high&include=catalog');
  assert.deepEqual(filtered.map(({ id }) => id), [child.id]);

  await receive(11, '/backlog октябрь');
  assert.match(last('sendMessage').text, /Билеты · к «Поездка»/);
  await receive(11, '/month ноябрь');
  assert.doesNotMatch(last('sendMessage').text, /Поездка/);
  await receive(11, '/major');
  const showCompleted = last('sendMessage').reply_markup.inline_keyboard.flat().find(({ callback_data }) => callback_data === 'l:major:done:0');
  await click(11, showCompleted.callback_data);
  const majorReport = last('editMessageText');
  const [completedTitle] = majorReport.entities;
  assert.equal(majorReport.text.slice(completedTitle.offset, completedTitle.offset + completedTitle.length), 'Поездка');

  const { data: { catalog } } = await call('labels', { initData: signed(11) });
  const [category] = catalog.categories;
  const [tag] = catalog.tags;
  assert.equal(category.name, 'Быт');
  assert.equal(tag.name, 'дом');
  assert.deepEqual((await call('labels', { initData: signed(33) })).data.catalog, { categories: [], tags: [] });
  assert.equal((await call(`labels/${category.id}`, { initData: signed(33), method: 'DELETE' })).code, 404);
  const { data: { label: updatedCategory } } = await call(`labels/${category.id}`, { method: 'PATCH', body: { icon: 'home', color: '#aa4400' } });
  assert.equal(updatedCategory.icon, 'home');
  assert.equal(updatedCategory.color, '#aa4400');
  const currentParent = data.tasks.find((task) => task.id === parent.id);
  const { data: { task: override } } = await call('tasks', {
    method: 'POST', body: { title: 'Отель', parentId: parent.id, period: '2026-12', categoryChoice: { id: category.id } },
  });
  assert.equal(override.category, 'Быт');
  assert.equal(override.period, '2026-12');
  const { data: { task: blank } } = await call('tasks', {
    method: 'POST', body: { title: 'Список вещей', parentId: parent.id, categoryChoice: null },
  });
  assert.equal(blank.category, null);
  assert.equal(blank.period, null);
  assert.equal((await call(`tasks/${blank.id}`, { method: 'DELETE', body: { version: blank.version + 1 } })).code, 409);
  assert.equal((await call(`tasks/${blank.id}`, { method: 'DELETE', body: { version: blank.version } })).code, 200);
  assert.equal((await call(`tasks/${blank.id}`)).code, 404);
  assert.equal((await patch(currentParent, { categoryChoice: { id: category.id }, tagChoices: [{ id: tag.id }, { name: 'Для двоих' }] })).code, 200);
  assert.equal((await call(`labels/${tag.id}`, { method: 'PATCH', body: { color: '#4287AF' } })).data.label.color, '#4287af');
  const repeated = await call('labels', { method: 'POST', body: { kind: 'category', name: ' быт ' } });
  assert.equal(repeated.data.label.id, category.id);
  assert.equal((await call(`labels/${tag.id}`, { method: 'DELETE' })).code, 200);
  assert.equal((await call(`labels/${category.id}`, { method: 'DELETE' })).code, 200);
  const updated = (await call(`tasks/${parent.id}`)).data.task;
  assert.equal(updated.category, null);
  assert.equal(updated.status, 'done');
  assert.deepEqual(updated.tags, ['Для двоих']);
  assert.equal((await patch(updated, { categoryChoice: { id: category.id } })).code, 404);
  const standalone = store.createTask(store.spaceFor(11).id, 11, { title: 'Большая задача' });
  const { data: { task: globalTask } } = await patch(standalone, { importance: 'global' });
  assert.equal(globalTask.importance, 'global');
  assert.equal((await patch(globalTask, { parentId: parent.id })).code, 400);
});

test('сроки и крупные задачи разделены, работают фильтры категории и ответственного', async (t) => {
  const { store, receive, last } = setup(t);
  await receive(11, '/start');
  const pair = store.spaceFor(11);
  await receive(22, '/start ' + pair.invite);
  await receive(33, '/start');
  const { id: space } = pair;
  const bills = store.createLabel(space, { kind: 'category', name: 'Платежи' });
  const big = store.createTask(space, 11, { title: 'Отпуск', period: '2026-11', importance: 'global' });
  const today = store.createTask(space, 11, { title: 'Купить билеты', period: '2026-11-22', assigneeId: 11, parentId: big.id });
  const partner = store.createTask(space, 11, { title: 'Позвонить', period: '2026-11-22', assigneeId: 22, categoryChoice: { id: bills.id } });
  const late = store.createTask(space, 11, { title: 'Пропущено вчера', period: '2026-11-21', assigneeId: 22, categoryChoice: { id: bills.id } });
  const month = store.createTask(space, 11, { title: 'Оплатить ЖКХ', period: '2026-11', categoryChoice: { id: bills.id } });
  const year = store.createTask(space, 11, { title: 'Запланировать ремонт', period: '2026' });
  const untimed = store.createTask(space, 11, { title: 'Починить полку' });
  store.createTask(space, 11, { title: 'День из октября', period: '2026-10-31' });
  const lastDay = store.createTask(space, 11, { title: 'Последний день ноября', period: '2026-11-30' });
  store.updateTask(space, lastDay.id, { version: lastDay.version, status: 'done' });
  store.createTask(space, 11, { title: 'День из декабря', period: '2026-12-01' });
  const canceled = store.createTask(space, 11, { title: 'Отменённая встреча', period: '2026-11-22' });
  store.updateTask(space, canceled.id, { version: canceled.version, status: 'obsolete' });
  assert.throws(() => store.createTask(space, 11, { title: 'Чужой', assigneeId: 33 }));
  assert.throws(() => store.createTask(space, 11, { title: 'Подзадача', parentId: big.id, importance: 'global' }));

  const server = webServer({
    store, token, username: 'test_bot', timeZone: 'Europe/Moscow', now: () => new Date('2026-11-22T18:01:00Z'),
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const get = async (path, user = 11) => {
    const response = await fetch(origin + '/api/' + path, { headers: { 'x-telegram-init-data': signed(user) } });
    assert.equal(response.status, 200);
    return response.json();
  };
  const ids = (tasks) => tasks.map(({ id }) => id);
  const session = await get('session');
  assert.equal(session.currentDay, '2026-11-22');
  assert.equal(session.partnerId, 22);
  assert.equal(session.groupSetupUrl, 'https://t.me/test_bot?startgroup=pair-chat');
  assert.deepEqual(session.members, [{ id: 11, name: 'Тест', slot: 1 }, { id: 22, name: 'Имя 22', slot: 2 }]);
  assert.deepEqual(ids((await get('tasks?scope=2026-11-22&view=day&assignee=me')).tasks), [today.id]);
  const filteredDay = await get('tasks?scope=2026-11-22&view=day&assignee=partner&include=catalog&categoryId=' + bills.id);
  assert.deepEqual(ids(filteredDay.tasks), [partner.id]);
  assert.deepEqual(ids(filteredDay.carryover), [late.id]);
  assert.equal(filteredDay.dayFinished, true);
  assert.deepEqual(filteredDay.members, session.members);
  assert.deepEqual(ids((await get('tasks?scope=2026-11-21&view=day')).tasks), [late.id]);
  const november = await get('tasks?scope=2026-11&view=month&include=catalog');
  assert.deepEqual(ids(november.tasks), [canceled.id, lastDay.id, month.id, late.id, partner.id, today.id]);
  const currentMonth = await get('tasks?scope=2026-11&view=month&status=current');
  assert.deepEqual(ids(currentMonth.tasks), [lastDay.id, month.id, late.id, partner.id, today.id]);
  const obsoleteDay = await get('tasks?scope=2026-11-22&view=day&status=obsolete');
  assert.deepEqual(ids(obsoleteDay.tasks), [canceled.id]);
  const filteredMonth = await get('tasks?scope=2026-11&view=month&assignee=partner&categoryId=' + bills.id);
  assert.deepEqual(ids(filteredMonth.tasks), [late.id, partner.id]);
  assert.deepEqual(ids((await get('tasks?scope=2026&view=year')).tasks), [year.id]);
  assert.deepEqual(ids((await get('tasks?scope=none&view=unscheduled')).tasks), [untimed.id]);
  assert.deepEqual(ids((await get('tasks?view=major')).tasks), [big.id]);
  const stats = await get('tasks?scope=2026&view=statistics&include=summary');
  assert.equal(stats.stats.total, 9);
  assert.equal(stats.monthStats['2026-11'].total, 6);
  await receive(11, '/day');
  assert.match(last('sendMessage').text, /Купить билеты/);
  await receive(11, '/month ноябрь');
  assert.match(last('sendMessage').text, /Последний день ноября/);
  assert.match(last('sendMessage').text, /Оплатить ЖКХ/);
  assert.doesNotMatch(last('sendMessage').text, /День из (октября|декабря)/);
  await receive(11, '/backlog');
  assert.doesNotMatch(last('sendMessage').text, /Отпуск\n/);
  await receive(11, '/start@test_bot pair-chat', group);
  const linked = await get('session', 22);
  assert.equal(linked.groupLinked, true);
  assert.equal(linked.groupSetupUrl, null);
});

test('назначение задачи и режим для двоих уведомляют партнёра в личном чате', async (t) => {
  const { store, receive, last } = setup(t);
  await receive(11, '/start');
  await receive(22, '/start ' + store.spaceFor(11).invite);

  const server = webServer({ store, token, username: 'test_bot', timeZone: 'Europe/Moscow' });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const save = async (user, path, method, body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/tasks${path}`, {
      method, headers: { 'x-telegram-init-data': signed(user), 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.equal(response.status, method === 'POST' ? 201 : 200);
    return (await response.json()).task;
  };
  const add = (user, body) => save(user, '', 'POST', body);
  const change = (user, task, body) => save(user, `/${task.id}`, 'PATCH', { version: task.version, ...body });

  const mine = await add(11, { title: 'Моя задача', assigneeId: 11 });
  assert.equal(store.pendingTaskNotification(), undefined);
  const partner = await add(11, { title: 'Позвонить', period: '2026-11-23', assigneeId: 22 });
  await change(11, partner, { title: 'Позвонить вечером', assigneeId: 22 });
  const shared = await add(22, { title: 'Собрать вещи', assigneeId: null });
  const withdrawn = await add(11, { title: 'Переназначена себе', assigneeId: 22 });
  await change(11, withdrawn, { assigneeId: 11 });
  await change(11, mine, { assigneeId: 22 });

  const first = store.pendingTaskNotification();
  const controller = new AbortController();
  const limitedBot = new Bot({ store, api: {
    async call() { throw Object.assign(new Error('rate limited'), { code: 429, retryAfter: 20 }); },
  } });
  await limitedBot.sendTaskNotification(first, controller.signal);
  assert.equal(store.pendingTaskNotification().taskId, shared.id);
  const retry = store.pendingTaskNotification(Date.now() + 21_000);
  assert.equal(retry.id, first.id);
  assert.equal(retry.attempts, 1);
  store.retryTaskNotification(first.id, 0);

  const sent = [];
  const worker = new Bot({ store, api: {
    async call(method, data) {
      assert.equal(method, 'sendMessage');
      sent.push(data);
      if (sent.length === 3) controller.abort();
    },
  } });
  await worker.processTaskNotifications(AbortSignal.any([controller.signal, AbortSignal.timeout(2000)]));
  assert.deepEqual(sent.map(({ chat_id }) => chat_id), [22, 11, 22]);
  assert.equal(sent[0].text, 'Вам назначили задачу\nПозвонить вечером\nСрок — 23 ноября 2026 г.');
  assert.equal(sent[1].text, 'Задача для двоих\nСобрать вещи');
  assert.equal(sent[2].reply_markup.inline_keyboard[0][0].callback_data, `t2:all:all:0:${mine.id}`);
  assert.equal(store.pendingTaskNotification(), undefined);
  await receive(22, '/task Купить хлеб');
  assert.match(last('sendMessage').text, /Добавлено/);
  assert.equal(store.pendingTaskNotification().recipient, 11);
});
