import { InputError } from './periods.js';
import { taskTitle } from './store.js';

export const maxVoiceSeconds = 90;
export const maxVoiceBytes = 4 * 1024 * 1024;
const maxTasks = 15;
const recognitionPrompt = 'Список задач. Купить, оплатить, забрать, позвонить, записаться, заказать.';

const ordinal = 'первое|второе|третье|четв[её]ртое|пятое|шестое|седьмое|восьмое|девятое|десятое';
const action = [
  'купить', 'взять', 'заказать', 'оплатить', 'заплатить', 'договориться', 'записаться',
  'позвонить', 'перезвонить', 'написать', 'попросить', 'узнать', 'проверить', 'забрать',
  'отвезти', 'отнести', 'принести', 'завезти', 'отправить', 'заполнить', 'скачать',
  'посмотреть', 'подготовить', 'найти', 'выбрать', 'забронировать', 'сделать', 'убрать',
  'помыть', 'приготовить', 'посетить', 'поменять', 'вернуть', 'внести', 'заменить',
  'сдать', 'получить', 'поставить', 'записать', 'починить', 'напомнить', 'обновить', 'оформить',
].join('|');
const spokenNumber = new RegExp(String.raw`(^|[\n,;.!?])\s*(?:(?:пункт\s+)?\d{1,2}[.)]|(?:${ordinal})[,:.–—-]?)\s+`, 'giu');
const betweenActions = new RegExp(String.raw`(?:\s*,\s*(?:и\s+)?|\s+и\s+)(?=(?:(?:а\s+ещ[её]|затем|потом)\s+)?(?:${action})\s)`, 'giu');
const sequence = /^(?:(?:а\s+ещ[её]|затем|потом)\s*,?\s+)/iu;
const filler = /^(?:вс[её]|это вс[её]|вот и вс[её]|спасибо(?: за просмотр)?|субтитры.*|продолжение следует|тишина|музыка)$/iu;

export function tasksFromSpeech(transcript) {
  const titles = transcript.trim()
    .replace(/^(?:мой\s+)?(?:список\s+задач|задачи(?:\s+на\s+сегодня)?)\s*[:.]\s*/iu, '')
    .replace(spokenNumber, '$1\n')
    .replace(betweenActions, '\n')
    .split(/[\n;]+|(?<=[\p{L}\p{N}]{2}[.!?…])\s+/u)
    .map((part) => part.trim().replace(/^(?:[•–—-]\s+)+/u, '').replace(/^\[(?:тишина|музыка|шум|смех|неразборчиво)\]$/iu, '')
      .replace(sequence, '').replace(/^[\s.,;:!?…]+|[\s.,;:!?…]+$/gu, ''))
    .filter((part) => /[\p{L}\p{N}]/u.test(part) && !filler.test(part));
  if (!titles.length) throw new InputError('Не удалось расслышать задачи. Попробуйте назвать их по одной с паузами.');
  if (titles.length > maxTasks) throw new InputError('В записи больше 15 задач. Разделите список на несколько голосовых.');
  return titles.map((title) => taskTitle(title[0].toLocaleUpperCase('ru') + title.slice(1)));
}

export function voiceTranscriber(endpoint, request = fetch) {
  const url = URL.parse(endpoint);
  if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Проверьте адрес VOICE_TRANSCRIBER_URL.');
  }
  return async (audio, signal) => {
    const body = new FormData();
    body.set('file', new Blob([audio], { type: 'audio/ogg' }), 'voice.ogg');
    body.set('response_format', 'json');
    body.set('temperature', '0');
    body.set('temperature_inc', '0.2');
    body.set('language', 'ru');
    body.set('prompt', recognitionPrompt);
    const response = await request(url, {
      method: 'POST', body, redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
    });
    if (!response.ok) throw new Error('Сервис распознавания вернул ошибку.');
    const result = await response.json();
    if (typeof result.text !== 'string') throw new Error('Сервис распознавания вернул неожиданный ответ.');
    return result.text.trim().replace(recognitionPrompt, '').trim();
  };
}
