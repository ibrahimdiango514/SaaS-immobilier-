import assert from 'node:assert/strict';
import test from 'node:test';
import {
  filterPipelineItems,
  getPipelineStageCounts,
  getPipelineStages,
  groupPipelineByStage,
  nextPipelineVisits,
  normalizePipelineSearch,
  partitionPipelineVisits,
  pipelineDateRangeError,
  pipelineStageLabel,
} from './pipeline-utils.js';

const contacts = [
  {
    id: 'contact-a', first_name: 'Équipe', last_name: 'Démo A', phone: '000-000-0001',
    email: 'equipe@example.test', whatsapp_number: null, assigned_user_id: 'agent-1',
  },
  {
    id: 'contact-b', first_name: 'Contact B', last_name: null, phone: null,
    email: 'moussa@example.test', whatsapp_number: null, assigned_user_id: null,
  },
];

const properties = [
  { id: 'property-a', reference: 'BKO-101', title: 'Villa du Fleuve', neighborhood: 'Badalabougou', city: 'Bamako' },
  { id: 'property-b', reference: 'BKO-102', title: 'Appartement central', neighborhood: null, city: 'Bamako' },
];

const opportunities = [
  {
    id: 'deal-a', client_id: 'contact-a', property_id: 'property-a', etape: 'Visite', probabilite: 45,
    notes: 'À rappeler', date_visite: '2026-10-17', created_at: '2026-10-01T10:00:00.000Z',
  },
  {
    id: 'deal-b', client_id: 'contact-b', property_id: 'property-b', etape: 'Premier contact', probabilite: 10,
    notes: null, date_visite: null, created_at: '2026-10-02T10:00:00.000Z',
  },
  {
    id: 'deal-c', client_id: 'contact-a', property_id: 'property-b', etape: 'Visite', probabilite: 60,
    notes: null, date_visite: '2026-10-19', created_at: '2026-10-03T10:00:00.000Z',
  },
  {
    id: 'deal-d', client_id: 'missing-contact', property_id: 'missing-property', etape: '  ', probabilite: 0,
    notes: 'Ancienne référence', date_visite: 'date-invalide', created_at: '2026-10-04T10:00:00.000Z',
  },
];

test('normalizes pipeline search and derives only the stored, observed stages', () => {
  assert.equal(normalizePipelineSearch('  ÉQUIPE   DÉMO A  '), 'equipe demo a');
  assert.equal(pipelineStageLabel('  Offre  '), 'Offre');
  assert.equal(pipelineStageLabel('  '), 'Étape non renseignée');
  assert.deepEqual(getPipelineStages(opportunities), ['Étape non renseignée', 'Premier contact', 'Visite']);
  assert.deepEqual(getPipelineStageCounts(opportunities), [
    { stage: 'Étape non renseignée', count: 1 },
    { stage: 'Premier contact', count: 1 },
    { stage: 'Visite', count: 2 },
  ]);
  assert.deepEqual(groupPipelineByStage(opportunities).map(({ stage, items }) => [stage, items.length]), [
    ['Étape non renseignée', 1],
    ['Premier contact', 1],
    ['Visite', 2],
  ]);
});

test('combines search, observed stage, contact assignee, and calendar-date range filters', () => {
  assert.deepEqual(
    filterPipelineItems(opportunities, contacts, properties, {
      search: 'equipe',
      stage: 'Visite',
      assignedUserId: 'agent-1',
      datePresence: 'scheduled',
      dateFrom: '2026-10-17',
      dateTo: '2026-10-18',
    }).map(({ id }) => id),
    ['deal-a'],
  );
  assert.deepEqual(
    filterPipelineItems(opportunities, contacts, properties, { search: 'BKO-102', stage: 'Visite' }).map(({ id }) => id),
    ['deal-c'],
  );
  assert.deepEqual(
    filterPipelineItems(opportunities, contacts, properties, { search: '0000000001' }).map(({ id }) => id),
    ['deal-a', 'deal-c'],
  );
});

test('keeps missing assignments distinct from unavailable contacts and filters undated items', () => {
  assert.deepEqual(
    filterPipelineItems(opportunities, contacts, properties, {
      assignedUserId: 'unassigned', datePresence: 'unscheduled',
    }).map(({ id }) => id),
    ['deal-b'],
  );
  assert.deepEqual(
    filterPipelineItems(opportunities, contacts, properties, { datePresence: 'scheduled' }).map(({ id }) => id),
    ['deal-a', 'deal-c'],
  );
  assert.deepEqual(
    filterPipelineItems(opportunities, contacts, properties, { dateFrom: '2026-10-17' }).map(({ id }) => id),
    ['deal-a', 'deal-c'],
  );
});

test('rejects invalid or reversed date ranges instead of returning misleading matches', () => {
  assert.equal(pipelineDateRangeError('not-a-date', ''), 'La date de début n’est pas valide.');
  assert.equal(pipelineDateRangeError('', '2026-02-30'), 'La date de fin n’est pas valide.');
  assert.equal(
    pipelineDateRangeError('2026-10-19', '2026-10-17'),
    'La date de début ne peut pas dépasser la date de fin.',
  );
  assert.equal(pipelineDateRangeError('2026-10-17', '2026-10-19'), null);
  assert.deepEqual(
    filterPipelineItems(opportunities, contacts, properties, { dateFrom: '2026-10-19', dateTo: '2026-10-17' }),
    [],
  );
});

test('partitions shared visit dates into upcoming, today, past, absent, and invalid records', () => {
  const partition = partitionPipelineVisits([
    opportunities[0],
    opportunities[1],
    opportunities[2],
    { ...opportunities[3], date_visite: '2026-10-16' },
    { ...opportunities[3], id: 'deal-invalid' },
  ], '2026-10-17');
  assert.deepEqual(partition.scheduledVisits.map(({ item, bucket }) => [item.id, bucket]), [
    ['deal-a', 'today'],
    ['deal-c', 'upcoming'],
    ['deal-d', 'past'],
  ]);
  assert.deepEqual(partition.unscheduledItems.map(({ id }) => id), ['deal-b']);
  assert.equal(partition.invalidDateCount, 1);
  assert.equal(partition.todayCount, 1);
  assert.equal(partition.upcomingCount, 1);
  assert.equal(partition.pastCount, 1);
  assert.deepEqual(nextPipelineVisits(partition.scheduledVisits, 5).map(({ item }) => item.id), ['deal-a', 'deal-c']);
});
