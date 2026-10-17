import type { ContactRow, PropertyRow, SalesPipelineRow } from './database.types';
import type { VisitDateBucket } from './visit-utils.js';

export type PipelineFilters = {
  search?: string;
  stage?: string | 'all';
  assignedUserId?: string | 'all' | 'unassigned';
  datePresence?: 'all' | 'scheduled' | 'unscheduled';
  dateFrom?: string;
  dateTo?: string;
};

export type PipelineStageGroup = {
  stage: string;
  items: SalesPipelineRow[];
};

export type PipelineStageCount = {
  stage: string;
  count: number;
};

export type PipelineVisit = {
  item: SalesPipelineRow;
  dateKey: string;
  bucket: VisitDateBucket;
};

export type PipelineVisitPartition = {
  scheduledVisits: PipelineVisit[];
  unscheduledItems: SalesPipelineRow[];
  invalidDateCount: number;
  todayCount: number;
  upcomingCount: number;
  pastCount: number;
};

export declare function pipelineStageLabel(value?: string | null): string;
export declare function normalizePipelineSearch(value?: string | null): string;
export declare function getPipelineStages(opportunities: readonly SalesPipelineRow[]): string[];
export declare function getPipelineStageCounts(opportunities: readonly SalesPipelineRow[]): PipelineStageCount[];
export declare function groupPipelineByStage(opportunities: readonly SalesPipelineRow[]): PipelineStageGroup[];
export declare function pipelineDateRangeError(fromValue?: string | null, toValue?: string | null): string | null;
export declare function filterPipelineItems(
  opportunities: readonly SalesPipelineRow[],
  contacts: readonly ContactRow[],
  properties: readonly PropertyRow[],
  filters?: PipelineFilters,
): SalesPipelineRow[];
export declare function partitionPipelineVisits(
  opportunities: readonly SalesPipelineRow[],
  today: string,
): PipelineVisitPartition;
export declare function nextPipelineVisits(scheduledVisits: readonly PipelineVisit[], limit?: number): PipelineVisit[];
