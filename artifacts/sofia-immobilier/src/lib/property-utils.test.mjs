import assert from 'node:assert/strict';
import test from 'node:test';
import {
  filterProperties,
  formatPropertyPrice,
  linkedOpportunitiesForProperty,
  isOptionalNonNegativeInteger,
  isOptionalPositiveFiniteNumber,
  isPositiveFinitePrice,
  normalizePropertySearch,
  propertyFormDefaults,
  propertyPriceRangeError,
} from './property-utils.js';

const properties = [
  {
    id: 'property-xof',
    reference: 'BI-001',
    title: 'Villa Étoile',
    property_type: 'Villa',
    transaction_type: 'sale',
    status: 'available',
    neighborhood: 'Sogoniko',
    city: 'Bamako',
    address: 'Rue des Écoles',
    price: 45000000,
    currency: 'XOF',
  },
  {
    id: 'property-eur',
    reference: 'BI-002',
    title: 'Appartement Bellevue',
    property_type: 'Appartement',
    transaction_type: 'rent',
    status: 'draft',
    neighborhood: 'Hamdallaye',
    city: 'Bamako',
    address: 'Avenue du Mali',
    price: 750.5,
    currency: 'EUR',
  },
  {
    id: 'property-reserved',
    reference: 'BI-003',
    title: 'Terrain à vendre',
    property_type: 'Terrain',
    transaction_type: 'sale',
    status: 'reserved',
    neighborhood: 'Sogoniko',
    city: 'Bamako',
    address: null,
    price: 12000000,
    currency: 'XOF',
  },
];

test('normalizes property searches so case, accents, and extra spaces do not block matches', () => {
  assert.equal(normalizePropertySearch('  ÉCOLES   Bamako '), 'ecoles bamako');
  assert.deepEqual(
    filterProperties(properties, { search: '  etoile ' }).map((property) => property.id),
    ['property-xof'],
  );
  assert.deepEqual(
    filterProperties(properties, { search: 'rue des ecoles' }).map((property) => property.id),
    ['property-xof'],
  );
  assert.deepEqual(
    filterProperties(properties, { search: 'rue    des   ecoles' }).map((property) => property.id),
    ['property-xof'],
  );
});

test('combines status, transaction/type, neighborhood, currency, and price filters', () => {
  assert.deepEqual(
    filterProperties(properties, {
      status: 'draft',
      kind: 'rent',
      neighborhood: 'Hamdallaye',
      currency: 'EUR',
      minPrice: '700',
      maxPrice: '800',
    }).map((property) => property.id),
    ['property-eur'],
  );
  assert.deepEqual(
    filterProperties(properties, { kind: 'Villa', currency: 'XOF' }).map((property) => property.id),
    ['property-xof'],
  );
});

test('requires one currency for price ranges instead of comparing unlike currencies', () => {
  assert.equal(propertyPriceRangeError('100', '', 'all'), 'Choisissez une devise avant de filtrer par prix.');
  assert.deepEqual(filterProperties(properties, { minPrice: '100' }), []);
  assert.deepEqual(
    filterProperties(properties, { minPrice: '100', currency: 'EUR' }).map((property) => property.id),
    ['property-eur'],
  );
});

test('validates price ranges and preserves the zero boundary for filters', () => {
  assert.equal(propertyPriceRangeError('', '', 'all'), null);
  assert.equal(propertyPriceRangeError('0', '0', 'XOF'), null);
  assert.equal(propertyPriceRangeError('-1', '', 'XOF'), 'Le prix minimum doit être un montant positif ou nul.');
  assert.equal(propertyPriceRangeError('', 'NaN', 'XOF'), 'Le prix maximum doit être un montant positif ou nul.');
  assert.equal(propertyPriceRangeError('900', '800', 'EUR'), 'Le prix minimum ne peut pas dépasser le prix maximum.');
  assert.deepEqual(filterProperties(properties, { minPrice: '900', maxPrice: '800', currency: 'EUR' }), []);
});

test('validates positive finite form prices, optional nonnegative integer counts, and positive areas', () => {
  assert.equal(isPositiveFinitePrice(1), true);
  assert.equal(isPositiveFinitePrice(0), false);
  assert.equal(isPositiveFinitePrice(-1), false);
  assert.equal(isPositiveFinitePrice(Number.NaN), false);
  assert.equal(isPositiveFinitePrice(Number.POSITIVE_INFINITY), false);

  for (const value of [undefined, '', '  ', '0', '3']) {
    assert.equal(isOptionalNonNegativeInteger(value), true);
  }
  for (const value of ['-1', '1.5', '4e2', '999999999999999999999']) {
    assert.equal(isOptionalNonNegativeInteger(value), false);
  }

  for (const value of [undefined, '', '  ', '0.01', '120.5']) {
    assert.equal(isOptionalPositiveFiniteNumber(value), value === '0.01' || value === '120.5' || value === undefined || value === '' || value === '  ');
  }
  for (const value of ['0', '-0.1', 'Infinity', 'not-a-number']) {
    assert.equal(isOptionalPositiveFiniteNumber(value), false);
  }
});

test('provides safe create defaults and pre-fills all editable fields without replacing nullable values', () => {
  assert.deepEqual(propertyFormDefaults(null, 'XOF'), {
    reference: '', title: '', transaction_type: 'sale', property_type: '', price: 0,
    currency: 'XOF', status: 'draft', neighborhood: '', city: 'Bamako', address: '', description: '',
    bedrooms: '', bathrooms: '', area_m2: '',
  });
  const item = {
    reference: 'BI-017', title: 'Villa du Fleuve', transaction_type: 'rent', property_type: 'Villa',
    price: 825000, currency: 'XOF', status: 'reserved', neighborhood: 'Badalabougou', city: null,
    address: 'Rue 17', description: 'Jardin arboré', bedrooms: 3, bathrooms: 2, area_m2: 145.5,
  };
  assert.deepEqual(propertyFormDefaults(item, 'EUR'), {
    reference: 'BI-017', title: 'Villa du Fleuve', transaction_type: 'rent', property_type: 'Villa', price: 825000,
    currency: 'XOF', status: 'reserved', neighborhood: 'Badalabougou', city: '', address: 'Rue 17',
    description: 'Jardin arboré', bedrooms: '3', bathrooms: '2', area_m2: '145.5',
  });
});

test('returns only opportunities whose existing property_id matches the property detail', () => {
  const opportunities = [
    { id: 'deal-one', property_id: 'property-xof' },
    { id: 'deal-other', property_id: 'property-eur' },
    { id: 'deal-two', property_id: 'property-xof' },
  ];
  assert.deepEqual(
    linkedOpportunitiesForProperty(opportunities, 'property-xof').map((opportunity) => opportunity.id),
    ['deal-one', 'deal-two'],
  );
  assert.deepEqual(linkedOpportunitiesForProperty(opportunities, null), []);
});

test('formats XOF without decimals, other currencies with up to two decimals, and invalid amounts safely', () => {
  assert.equal(formatPropertyPrice(1250000, 'XOF'), `${new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 }).format(1250000)} FCFA`);
  assert.equal(formatPropertyPrice(1250.5, 'EUR'), `${new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2 }).format(1250.5)} EUR`);
  assert.equal(formatPropertyPrice(Number.NaN, 'USD'), 'Prix indisponible');
});
