import assert from 'node:assert/strict';
import { once, EventEmitter } from 'node:events';
import test from 'node:test';
import { Bot, TelegramApi } from '../src/bot.js';
import { Store } from '../src/store.js';
import { tasksFromSpeech, voiceTranscriber } from '../src/voice.js';

test('голосовой список делится на задачи без разрыва списка покупок', () => {
  assert.deepEqual(tasksFromSpeech('Список задач: первое, купить молоко, яйца и хлеб; второе, оплатить интернет. Третье, позвонить маме. Всё.'), [
    'Купить молоко, яйца и хлеб', 'Оплатить интернет', 'Позвонить маме',
  ]);
  assert.deepEqual(tasksFromSpeech('Купить молоко, проверить почту и забрать посылку.'), [
    'Купить молоко', 'Проверить почту', 'Забрать посылку',
  ]);
  assert.deepEqual(tasksFromSpeech('1. Позвонить маме. 2. Оплатить ЖКХ.'), ['Позвонить маме', 'Оплатить ЖКХ']);
  assert.deepEqual(tasksFromSpeech('Купить морковь.'), ['Купить морковь']);
  assert.throws(() => tasksFromSpeech('[музыка]'), /Не удалось расслышать/);
  assert.throws(() => tasksFromSpeech(Array(16).fill('Позвонить').join('; ')), /больше 15/);
});

test('личное голосовое приходит в общий бэклог один раз, голосовое группы пропускается', async (t) => {
  const store = new Store(':memory:');
  const space = store.joinOrCreate(11);
  store.joinOrCreate(22, space.invite);
  store.linkGroup(space.id, -10012);
  const controller = new AbortController();
  const events = new EventEmitter();
  let downloads = 0;
  const api = {
    async downloadVoice(fileId) {
      assert.equal(fileId, 'private-voice');
      downloads++;
      return Buffer.from('OggS');
    },
    async call(method, body) { events.emit(method, body); },
  };
  const transcribe = voiceTranscriber('http://speech.test/inference', async (_url, { body }) => {
    assert.equal(body.get('language'), 'ru');
    assert.equal(await body.get('file').text(), 'OggS');
    return Response.json({ text: 'Купить молоко. Оплатить интернет.' });
  });
  const options = { api, store, transcribe, username: 'test_bot', timeZone: 'Europe/Moscow' };
  const bot = new Bot(options);
  const groupVoice = { message: {
    message_id: 20, chat: { id: -10012, type: 'supergroup' }, from: { id: 11 },
    voice: { duration: 5, file_id: 'group-voice' },
  } };
  await bot.handle(groupVoice);
  assert.equal(store.pendingVoice(), undefined);
  const privateVoice = { message: {
    message_id: 21, chat: { id: 11, type: 'private' }, from: { id: 11 },
    voice: { duration: 8, file_id: 'private-voice' },
  } };
  await bot.handle(privateVoice);
  await bot.handle(privateVoice);
  const notification = once(events, 'sendMessage');
  const worker = new Bot(options).processVoices(controller.signal);
  t.after(async () => {
    controller.abort();
    await worker;
    store.close();
  });
  const [reply] = await notification;
  assert.equal(reply.reply_parameters.message_id, 21);
  assert.match(reply.text, /Купить молоко\n• Оплатить интернет/);
  assert.deepEqual(reply.reply_markup.inline_keyboard.map(([{ text }]) => text), ['Купить молоко', 'Оплатить интернет']);
  await bot.handle(privateVoice);
  assert.equal(downloads, 1);
  assert.equal(store.pendingVoice(), undefined);
  assert.deepEqual(store.list(store.spaceFor(22).id).map((task) => task.title), ['Купить молоко', 'Оплатить интернет']);
});

test('голосовой файл скачивается с фиксированного адреса Telegram', async () => {
  const calls = [];
  const api = new TelegramApi('12345:test', async (url, options) => {
    calls.push([url, options]);
    if (options.method === 'POST') return Response.json({ ok: true, result: { file_path: 'voice/file_1.oga', file_size: 4 } });
    return new Response('OggS');
  });
  const clip = await api.downloadVoice('fake-file', new AbortController().signal);
  assert.equal(clip.toString(), 'OggS');
  assert.equal(JSON.parse(calls[0][1].body).file_id, 'fake-file');
  assert.equal(calls[1][0], 'https://api.telegram.org/file/bot12345:test/voice/file_1.oga');
  assert.equal(calls[1][1].redirect, 'error');
});
