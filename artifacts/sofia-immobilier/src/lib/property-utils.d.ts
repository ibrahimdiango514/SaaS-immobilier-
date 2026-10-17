import type { PropertyRow, PropertyStatus, PropertyTransactionType, SalesPipelineRow } from './database.types';

export type PropertyFilters = {
  search?: string;
  status?: string;
  kind?: string;
  neighborhood?: string;
  currency?: string;
  minPrice?: string;
  maxPrice?: string;
};

export declare function normalizePropertySearch(value?: string | null): string;
export declare function isPositiveFinitePrice(value: number): boolean;
export declare function isOptionalNonNegativeInteger(value?: string | null): boolean;
export declare function isOptionalPositiveFiniteNumber(value?: string | null): boolean;
export declare function propertyPriceRangeError(
  minValue?: string | null,
  maxValue?: string | null,
  currency?: string,
): string | null;
export declare function filterProperties(
  properties: readonly PropertyRow[],
  filters?: PropertyFilters,
): PropertyRow[];
export declare function formatPropertyPrice(price: number, currency: string, locale?: string): string;
export declare function linkedOpportunitiesForProperty(
  opportunities: readonly SalesPipelineRow[],
  propertyId?: string | null,
): SalesPipelineRow[];

export type PropertyFormDefaults = {
  reference: string;
  title: string;
  transaction_type: PropertyTransactionType;
  property_type: string;
  price: number;
  currency: string;
  status: PropertyStatus;
  neighborhood: string;
  city: string;
  address: string;
  description: string;
  bedrooms: string;
  bathrooms: string;
  area_m2: string;
};
export declare function propertyFormDefaults(item: PropertyRow | null, agencyCurrency: string): PropertyFormDefaults;
