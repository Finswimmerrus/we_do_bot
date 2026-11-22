export const months = [
  'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь',
];

const monthForms = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];

export class InputError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export function currentPeriod(timeZone, now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit' })
    .format(now).slice(0, 7);
}

export function exactPeriod(value) {
  if (typeof value !== 'string' || !/^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test(value)) {
    throw new InputError('Укажите месяц и год.');
  }
  return value;
}

export function parseYear(value) {
  if (typeof value !== 'string' || !/^[1-9]\d{3}$/.test(value)) {
    throw new InputError('Укажите год четырьмя цифрами, например 2026.');
  }
  return value;
}

export function parseMonth(value, current) {
  if (!value.trim()) return current;
  const [name, year, extra] = value.trim().toLowerCase().split(/\s+/);
  const number = /^\d{1,2}$/.test(name) ? Number(name) :
    Math.max(months.findIndex((label) => label.toLowerCase() === name), monthForms.indexOf(name)) + 1;
  if (number < 1 || number > 12 || extra) {
    throw new InputError('Укажите месяц, например «октябрь 2026» или «10 2026».');
  }
  const [currentYear, currentMonth] = current.split('-').map(Number);
  const previous = currentMonth === 1 ? 12 : currentMonth - 1;
  let resolvedYear = currentYear;
  if (year) resolvedYear = parseYear(year);
  else if (number === previous && currentMonth === 1) resolvedYear--;
  else if (number < currentMonth && number !== previous) resolvedYear++;
  return exactPeriod(`${resolvedYear}-${String(number).padStart(2, '0')}`);
}

export function shiftMonth(value, offset) {
  const [year, month] = value.split('-').map(Number);
  const next = year * 12 + month - 1 + offset;
  const nextYear = Math.floor(next / 12);
  if (nextYear < 1000 || nextYear > 9999) return null;
  return `${nextYear}-${String(next % 12 + 1).padStart(2, '0')}`;
}

export function labelPeriod(value) {
  if (!value) return 'Без месяца';
  return `${months[Number(value.slice(5)) - 1]} ${value.slice(0, 4)}`;
}

export function parseScope(value) {
  if (value === 'all' || value === 'none') return value;
  if (value?.length === 4) return parseYear(value);
  return exactPeriod(value);
}
