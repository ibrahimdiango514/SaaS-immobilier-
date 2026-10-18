export function localDateKey(date = new Date()) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) return null;
  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function visitDateKey(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(value.trim());
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() + 1 !== month
    || date.getUTCDate() !== day
  ) {
    return null;
  }
  return `${match[1]}-${match[2]}-${match[3]}`;
}

export function visitDateBucket(value, today) {
  const dateKey = visitDateKey(value);
  const todayKey = visitDateKey(today);
  if (!dateKey || !todayKey) return null;
  if (dateKey === todayKey) return 'today';
  return dateKey > todayKey ? 'upcoming' : 'past';
}

export function formatVisitDate(value, locale = 'fr-FR') {
  const dateKey = visitDateKey(value);
  if (!dateKey) return 'Date à vérifier';

  const [year, month, day] = dateKey.split('-').map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  return new Intl.DateTimeFormat(locale, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}
