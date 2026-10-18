export type VisitDateBucket = 'today' | 'upcoming' | 'past';

export declare function localDateKey(date?: Date): string | null;
export declare function visitDateKey(value?: string | null): string | null;
export declare function visitDateBucket(
  value?: string | null,
  today?: string | null,
): VisitDateBucket | null;
export declare function formatVisitDate(value?: string | null, locale?: string): string;
