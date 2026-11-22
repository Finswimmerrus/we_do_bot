import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Bot } from '../src/bot.js';
import { currentPeriod, parseMonth } from '../src/periods.js';
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
    const message = { message_id: ++messageId, chat, from: { id: user }, text };
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
});

test('личный и связанный общий чаты используют один бэклог пары', async (t) => {
  const { store, receive, click, last, requests, latestMessageId } = setup(t);
  await receive(11, '/start');
  const initial = store.spaceFor(11);
  assert.match(last('sendMessage').text, new RegExp(initial.invite));
  await receive(22, `/start ${initial.invite}`);
  assert.equal(store.spaceFor(22).id, initial.id);
  await receive(33, `/start ${initial.invite}`);
  assert.equal(store.spaceFor(33), null);
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

test('Mini App копирует категорию при создании и сохраняет свой период подзадачи', async (t) => {
  const { store, receive, last } = setup(t);
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
  const { code, data: { task: child } } = await call('tasks', { method: 'POST', body: { title: 'Билеты', parentId: parent.id } });
  assert.equal(code, 201);
  assert.equal(child.period, null);
  assert.equal(child.category, 'Быт');
  assert.equal((await call('tasks', { method: 'POST', body: { title: 'Ещё уровень', parentId: child.id } })).code, 400);
  assert.equal((await patch(plannedParent, { parentId: child.id })).code, 400);
  assert.equal((await patch(child, { importance: 'global' })).code, 400);
  const { data: { task: plannedChild } } = await patch(child, { period: '2026-10', tags: ['Дом', 'дом'], importance: 'high' });
  assert.equal(plannedChild.period, '2026-10');
  assert.equal(plannedChild.category, 'Быт');
  assert.equal(plannedChild.importance, 'high');
  assert.equal((await patch(plannedParent, { period: '2026-11', category: 'Поездки', status: 'done' })).code, 200);
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
  const monthReport = last('sendMessage');
  assert.match(monthReport.text, /Выполнено 1/);
  const [completedTitle] = monthReport.entities;
  assert.equal(monthReport.text.slice(completedTitle.offset, completedTitle.offset + completedTitle.length), 'Поездка');

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
