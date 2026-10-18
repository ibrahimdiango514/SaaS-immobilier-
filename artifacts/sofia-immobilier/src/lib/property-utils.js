export function normalizePropertySearch(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase('fr');
}

export function isPositiveFinitePrice(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export function isOptionalNonNegativeInteger(value) {
  if (value === undefined || value === null) return true;
  if (typeof value !== 'string') return false;
  const normalized = value.trim();
  if (!normalized) return true;
  if (!/^\d+$/.test(normalized)) return false;
  return Number.isSafeInteger(Number(normalized));
}

export function isOptionalPositiveFiniteNumber(value) {
  if (value === undefined || value === null) return true;
  if (typeof value !== 'string') return false;
  const normalized = value.trim();
  if (!normalized) return true;
  const number = Number(normalized);
  return Number.isFinite(number) && number > 0;
}

export function propertyPriceRangeError(minValue, maxValue, currency = 'all') {
  const minText = String(minValue ?? '').trim();
  const maxText = String(maxValue ?? '').trim();
  const minPrice = minText ? Number(minText) : null;
  const maxPrice = maxText ? Number(maxText) : null;

  if (minPrice !== null && (!Number.isFinite(minPrice) || minPrice < 0)) {
    return 'Le prix minimum doit être un montant positif ou nul.';
  }
  if (maxPrice !== null && (!Number.isFinite(maxPrice) || maxPrice < 0)) {
    return 'Le prix maximum doit être un montant positif ou nul.';
  }
  if ((minText || maxText) && (!currency || currency === 'all')) {
    return 'Choisissez une devise avant de filtrer par prix.';
  }
  if (minPrice !== null && maxPrice !== null && minPrice > maxPrice) {
    return 'Le prix minimum ne peut pas dépasser le prix maximum.';
  }
  return null;
}

export function filterProperties(properties, filters = {}) {
  const search = normalizePropertySearch(filters.search);
  const minText = String(filters.minPrice ?? '').trim();
  const maxText = String(filters.maxPrice ?? '').trim();
  if (propertyPriceRangeError(minText, maxText, filters.currency ?? 'all')) return [];
  const minPrice = minText ? Number(minText) : null;
  const maxPrice = maxText ? Number(maxText) : null;

  return properties.filter((property) => {
    const searchableText = normalizePropertySearch([
      property.reference,
      property.title,
      property.property_type,
      property.neighborhood,
      property.city,
      property.address,
    ].filter(Boolean).join(' '));
    const searchMatches = !search || searchableText.includes(search);
    const statusMatches = !filters.status || filters.status === 'all' || property.status === filters.status;
    const typeMatches = !filters.kind || filters.kind === 'all'
      || property.transaction_type === filters.kind
      || property.property_type === filters.kind;
    const neighborhoodMatches = !filters.neighborhood || filters.neighborhood === 'all'
      || property.neighborhood === filters.neighborhood;
    const currencyMatches = !filters.currency || filters.currency === 'all'
      || property.currency === filters.currency;
    const minMatches = minPrice === null || property.price >= minPrice;
    const maxMatches = maxPrice === null || property.price <= maxPrice;
    return searchMatches && statusMatches && typeMatches && neighborhoodMatches
      && currencyMatches && minMatches && maxMatches;
  });
}

export function formatPropertyPrice(price, currency, locale = 'fr-FR') {
  if (!Number.isFinite(price)) return 'Prix indisponible';
  const maximumFractionDigits = currency === 'XOF' ? 0 : 2;
  const formatted = new Intl.NumberFormat(locale, { maximumFractionDigits }).format(price);
  return `${formatted} ${currency === 'XOF' ? 'FCFA' : currency}`;
}

export function linkedOpportunitiesForProperty(opportunities, propertyId) {
  if (!propertyId) return [];
  return opportunities.filter((opportunity) => opportunity.property_id === propertyId);
}

export function propertyFormDefaults(item, agencyCurrency) {
  return {
    reference: item?.reference ?? '',
    title: item?.title ?? '',
    transaction_type: item?.transaction_type ?? 'sale',
    property_type: item?.property_type ?? '',
    price: item?.price ?? 0,
    currency: item?.currency ?? agencyCurrency,
    status: item?.status ?? 'draft',
    neighborhood: item?.neighborhood ?? '',
    city: item ? item.city ?? '' : 'Bamako',
    address: item?.address ?? '',
    description: item?.description ?? '',
    bedrooms: item?.bedrooms == null ? '' : String(item.bedrooms),
    bathrooms: item?.bathrooms == null ? '' : String(item.bathrooms),
    area_m2: item?.area_m2 == null ? '' : String(item.area_m2),
  };
}
