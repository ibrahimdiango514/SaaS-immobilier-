import type { RevenueOperationRow } from './database.types';

export const operationTypeLabels: Record<string, string> = {
  sale: 'Vente',
  rental: 'Location',
  commission: 'Commission',
  other: 'Autre',
};

export const operationStatusLabels: Record<string, string> = {
  completed: 'Effectuée',
  pending: 'En attente',
  cancelled: 'Annulée',
};

export const CHART_COLORS = ['#0E9F6E', '#D9A441', '#3B82F6', '#8B5CF6', '#F97316', '#06B6D4', '#EC4899'];

export type PeriodKey = 'month' | 'm3' | 'm6' | 'm12' | 'year' | 'custom' | 'all';

export type DateRange = { from: Date | null; to: Date | null };

function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}
function endOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0, 23, 59, 59, 999);
}
function addMonths(date: Date, months: number): Date {
  return new Date(date.getFullYear(), date.getMonth() + months, 1);
}

export function periodRange(key: PeriodKey, customFrom?: string, customTo?: string): DateRange {
  const now = new Date();
  switch (key) {
    case 'month':
      return { from: startOfMonth(now), to: endOfMonth(now) };
    case 'm3':
      return { from: addMonths(startOfMonth(now), -2), to: endOfMonth(now) };
    case 'm6':
      return { from: addMonths(startOfMonth(now), -5), to: endOfMonth(now) };
    case 'm12':
      return { from: addMonths(startOfMonth(now), -11), to: endOfMonth(now) };
    case 'year':
      return { from: new Date(now.getFullYear(), 0, 1), to: new Date(now.getFullYear(), 11, 31, 23, 59, 59, 999) };
    case 'custom': {
      const from = customFrom ? new Date(`${customFrom}T00:00:00`) : null;
      const to = customTo ? new Date(`${customTo}T23:59:59`) : null;
      return { from, to };
    }
    default:
      return { from: null, to: null };
  }
}

export function previousRange(range: DateRange): DateRange {
  if (!range.from || !range.to) return { from: null, to: null };
  const span = range.to.getTime() - range.from.getTime();
  const to = new Date(range.from.getTime() - 1);
  const from = new Date(to.getTime() - span);
  return { from, to };
}

export function withinRange(operationDate: string, range: DateRange): boolean {
  const date = new Date(`${operationDate}T12:00:00`);
  if (range.from && date < range.from) return false;
  if (range.to && date > range.to) return false;
  return true;
}

export function filterOperations(operations: RevenueOperationRow[], range: DateRange): RevenueOperationRow[] {
  return operations.filter((operation) => withinRange(operation.operation_date, range));
}

/** CA = somme des COMMISSIONS enregistrées (le volume des transactions = somme des montants). */
export function completedSum(operations: RevenueOperationRow[]): number {
  return operations
    .filter((operation) => operation.status === 'completed')
    .reduce((total, operation) => total + Number(operation.commission || 0), 0);
}

export function completedVolume(operations: RevenueOperationRow[]): number {
  return operations
    .filter((operation) => operation.status === 'completed')
    .reduce((total, operation) => total + Number(operation.amount || 0), 0);
}

export type PeriodStats = {
  ca: number;
  volume: number;
  count: number;
  avg: number;
  previousCa: number;
  previousVolume: number;
  variation: number | null;
  cancelledCount: number;
  pendingCount: number;
};

export function computeStats(all: RevenueOperationRow[], range: DateRange): PeriodStats {
  const current = filterOperations(all, range);
  const completed = current.filter((operation) => operation.status === 'completed');
  const previous = filterOperations(all, previousRange(range));
  const ca = completedSum(completed);
  const volume = completedVolume(completed);
  const previousCa = completedSum(previous);
  const previousVolume = completedVolume(previous);
  const variation = previousCa > 0 ? ((ca - previousCa) / previousCa) * 100 : null;
  return {
    ca,
    volume,
    count: completed.length,
    avg: completed.length ? ca / completed.length : 0,
    previousCa,
    previousVolume,
    variation,
    cancelledCount: current.filter((operation) => operation.status === 'cancelled').length,
    pendingCount: current.filter((operation) => operation.status === 'pending').length,
  };
}

const MONTHS_SHORT = ['Jan', 'Fév', 'Mar', 'Avr', 'Mai', 'Juin', 'Juil', 'Août', 'Sep', 'Oct', 'Nov', 'Déc'];
const MONTHS_LONG = [
  'Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin',
  'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre',
];

export function monthLabel(date: Date, long = false): string {
  return `${long ? MONTHS_LONG[date.getMonth()] : MONTHS_SHORT[date.getMonth()]} ${String(date.getFullYear()).slice(2)}`;
}

export type Bucket = { label: string; ca: number; volume: number; count: number; key: string };

export function bucketize(
  operations: RevenueOperationRow[],
  range: DateRange,
  granularity: 'month' | 'quarter' | 'year',
): Bucket[] {
  const completed = operations.filter((operation) => operation.status === 'completed');
  const map = new Map<string, Bucket>();

  const push = (date: Date, commission: number, amount: number) => {
    let key: string;
    let label: string;
    if (granularity === 'month') {
      key = `${date.getFullYear()}-${date.getMonth()}`;
      label = monthLabel(date);
    } else if (granularity === 'quarter') {
      const quarter = Math.floor(date.getMonth() / 3) + 1;
      key = `${date.getFullYear()}-T${quarter}`;
      label = `T${quarter} ${String(date.getFullYear()).slice(2)}`;
    } else {
      key = String(date.getFullYear());
      label = String(date.getFullYear());
    }
    const bucket = map.get(key) ?? { key, label, ca: 0, volume: 0, count: 0 };
    bucket.ca += commission;
    bucket.volume += amount;
    bucket.count += 1;
    map.set(key, bucket);
  };

  for (const operation of completed) {
    const date = new Date(`${operation.operation_date}T12:00:00`);
    if (!withinRange(operation.operation_date, range)) continue;
    push(date, Number(operation.commission || 0), Number(operation.amount || 0));
  }

  const list = [...map.values()];
  if (granularity === 'year') list.sort((a, b) => Number(a.key) - Number(b.key));
  else list.sort((a, b) => (a.key > b.key ? 1 : -1));
  return list;
}

export function cumulativeYear(operations: RevenueOperationRow[], year: number): Array<{ label: string; ca: number; volume: number; cumul: number }> {
  const monthly = Array.from({ length: 12 }, (_, month) => ({ month, ca: 0, volume: 0 }));
  for (const operation of operations) {
    if (operation.status !== 'completed') continue;
    const date = new Date(`${operation.operation_date}T12:00:00`);
    if (date.getFullYear() !== year) continue;
    monthly[date.getMonth()].ca += Number(operation.commission || 0);
    monthly[date.getMonth()].volume += Number(operation.amount || 0);
  }
  let running = 0;
  return monthly.map((entry, month) => {
    running += entry.ca;
    return { label: MONTHS_SHORT[month], ca: entry.ca, volume: entry.volume, cumul: running };
  });
}

export function typeBreakdown(operations: RevenueOperationRow[]): Array<{ name: string; value: number }> {
  const map = new Map<string, number>();
  for (const operation of operations) {
    if (operation.status !== 'completed') continue;
    const name = operationTypeLabels[operation.operation_type] ?? operation.operation_type;
    map.set(name, (map.get(name) ?? 0) + Number(operation.commission || 0));
  }
  return [...map.entries()].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
}

export function propertyBreakdown(
  operations: RevenueOperationRow[],
  propertyTitles: Map<string, string>,
): Array<{ name: string; value: number }> {
  const map = new Map<string, number>();
  for (const operation of operations) {
    if (operation.status !== 'completed') continue;
    const key = operation.property_id ?? '';
    const name = key ? (propertyTitles.get(key) ?? 'Bien supprimé') : 'Hors bien';
    map.set(name, (map.get(name) ?? 0) + Number(operation.commission || 0));
  }
  return [...map.entries()].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
}

export function bestMonth(operations: RevenueOperationRow[], sinceMonths = 12): { label: string; ca: number } | null {
  const limit = new Date();
  limit.setMonth(limit.getMonth() - sinceMonths);
  const map = new Map<string, { date: Date; ca: number }>();
  for (const operation of operations) {
    if (operation.status !== 'completed') continue;
    const date = new Date(`${operation.operation_date}T12:00:00`);
    if (date < limit) continue;
    const key = `${date.getFullYear()}-${date.getMonth()}`;
    const entry = map.get(key) ?? { date: new Date(date.getFullYear(), date.getMonth(), 1), ca: 0 };
    entry.ca += Number(operation.commission || 0);
    map.set(key, entry);
  }
  let best: { label: string; ca: number } | null = null;
  for (const entry of map.values()) {
    if (!best || entry.ca > best.ca) best = { label: monthLabel(entry.date, true), ca: entry.ca };
  }
  return best;
}
