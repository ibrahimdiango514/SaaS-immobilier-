import assert from 'node:assert/strict';
import test from 'node:test';
import { pipelineFormSchema } from './pipeline-schema.js';

const validValues = {
  client_id: 'contact-1',
  property_id: 'property-1',
  etape: '  Visite  ',
  probabilite: 35,
  date_visite: '2026-10-17',
  notes: '  Premier échange  ',
};

test('validates required relations and free-text stage without inventing a fixed stage enum', () => {
  assert.equal(pipelineFormSchema.safeParse(validValues).success, true);
  assert.equal(pipelineFormSchema.safeParse({ ...validValues, client_id: '' }).success, false);
  assert.equal(pipelineFormSchema.safeParse({ ...validValues, property_id: ' ' }).success, false);
  assert.equal(pipelineFormSchema.safeParse({ ...validValues, etape: '  ' }).success, false);
});

test('constrains probability to the available 0–100 percentage field', () => {
  for (const probabilite of [0, 12.5, 100]) {
    assert.equal(pipelineFormSchema.safeParse({ ...validValues, probabilite }).success, true);
  }
  for (const probabilite of [-1, 100.1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(pipelineFormSchema.safeParse({ ...validValues, probabilite }).success, false);
  }
});

test('accepts an empty optional visit date but rejects invalid calendar dates', () => {
  assert.equal(pipelineFormSchema.safeParse({ ...validValues, date_visite: '' }).success, true);
  assert.equal(pipelineFormSchema.safeParse({ ...validValues, date_visite: undefined }).success, true);
  assert.equal(pipelineFormSchema.safeParse({ ...validValues, date_visite: '2026-02-30' }).success, false);
  assert.equal(pipelineFormSchema.safeParse({ ...validValues, date_visite: '17/10/2026' }).success, false);
});

test('trims stage and notes before the mutation receives them', () => {
  const result = pipelineFormSchema.safeParse(validValues);
  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.data.etape, 'Visite');
    assert.equal(result.data.notes, 'Premier échange');
  }
});
