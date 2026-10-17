import assert from 'node:assert/strict';
import test from 'node:test';
import { contactFormSchema } from './contact-schema.js';
import {
  canAssignContactToMember,
  contactFormDefaults,
  filterContacts,
  formatContactName,
  getAssignableContactMembers,
  linkedOpportunitiesForContact,
  normalizeContactSearch,
} from './contact-utils.js';

const contacts = [
  {
    id: 'contact-a',
    first_name: 'Équipe',
    last_name: 'Démo A',
    phone: '000-000-0001',
    email: 'equipe@example.test',
    whatsapp_number: '000-000-0001',
    status: 'prospect',
    source: 'Recommandation',
    assigned_user_id: 'agent-1',
  },
  {
    id: 'contact-b',
    first_name: 'Contact B',
    last_name: null,
    phone: null,
    email: 'contact-b@example.test',
    whatsapp_number: null,
    status: 'lead',
    source: 'Site web',
    assigned_user_id: null,
  },
  {
    id: 'contact-c',
    first_name: 'Contact C',
    last_name: 'Démo C',
    phone: '000-000-0003',
    email: null,
    whatsapp_number: null,
    status: 'client',
    source: 'Salon immobilier',
    assigned_user_id: 'agent-2',
  },
];

test('normalizes accents, case, and repeated spaces for contact searches', () => {
  assert.equal(normalizeContactSearch('  ÉQUIPE   DÉMO A  '), 'equipe demo a');
  assert.deepEqual(filterContacts(contacts, { search: 'equipe   demo a' }).map(({ id }) => id), ['contact-a']);
  assert.deepEqual(filterContacts(contacts, { search: '000-000-0001' }).map(({ id }) => id), ['contact-a']);
  assert.deepEqual(filterContacts(contacts, { search: '0000000001' }).map(({ id }) => id), ['contact-a']);
  assert.deepEqual(filterContacts(contacts, { search: 'recommandation' }).map(({ id }) => id), ['contact-a']);
});

test('combines status and assignee filters, including the unassigned bucket', () => {
  assert.deepEqual(
    filterContacts(contacts, { status: 'prospect', assignedUserId: 'agent-1' }).map(({ id }) => id),
    ['contact-a'],
  );
  assert.deepEqual(
    filterContacts(contacts, { status: 'lead', assignedUserId: 'unassigned' }).map(({ id }) => id),
    ['contact-b'],
  );
  assert.deepEqual(filterContacts(contacts, { assignedUserId: 'agent-missing' }), []);
  assert.deepEqual(filterContacts(contacts, { status: 'all', assignedUserId: 'all' }), contacts);
});

test('limits new contact assignees to active non-viewer agency members', () => {
  const members = [
    { user_id: 'owner-1', role: 'owner', status: 'active' },
    { user_id: 'admin-1', role: 'admin', status: 'active' },
    { user_id: 'manager-1', role: 'manager', status: 'active' },
    { user_id: 'agent-1', role: 'agent', status: 'active' },
    { user_id: 'viewer-1', role: 'viewer', status: 'active' },
    { user_id: 'agent-2', role: 'agent', status: 'suspended' },
    { user_id: 'agent-3', role: 'agent', status: 'removed' },
  ];
  assert.deepEqual(
    getAssignableContactMembers(members).map(({ user_id }) => user_id),
    ['owner-1', 'admin-1', 'manager-1', 'agent-1'],
  );
  assert.equal(canAssignContactToMember('agent-1', members), true);
  assert.equal(canAssignContactToMember('viewer-1', members), false);
  assert.equal(canAssignContactToMember('agent-2', members), false);
  assert.equal(canAssignContactToMember('missing-member', members), false);
  assert.equal(canAssignContactToMember('', members), true);
  assert.equal(canAssignContactToMember('agent-2', members, 'agent-2'), true);
});

test('validates required names, optional and normalized contact fields, status, and UUID assignees', () => {
  const defaults = contactFormDefaults(null);
  assert.equal(contactFormSchema.safeParse({ ...defaults, first_name: '   ' }).success, false);
  assert.equal(contactFormSchema.safeParse({ ...defaults, first_name: 'Contact', email: 'not-an-email' }).success, false);
  assert.equal(contactFormSchema.safeParse({ ...defaults, first_name: 'Contact', assigned_user_id: 'not-a-uuid' }).success, false);

  const valid = contactFormSchema.safeParse({
    ...defaults,
    first_name: '  Contact  ',
    last_name: '  Démo  ',
    phone: '  000-000-0002  ',
    email: '  demo@example.test  ',
    whatsapp_number: '   ',
    notes: '  Premier échange  ',
    assigned_user_id: '6b2f6e7a-6e89-4fb1-9fc4-223a6f8c2b10',
  });
  assert.equal(valid.success, true);
  if (valid.success) {
    assert.equal(valid.data.first_name, 'Contact');
    assert.equal(valid.data.last_name, 'Démo');
    assert.equal(valid.data.phone, '000-000-0002');
    assert.equal(valid.data.email, 'demo@example.test');
    assert.equal(valid.data.whatsapp_number, '');
    assert.equal(valid.data.notes, 'Premier échange');
  }
  assert.equal(contactFormSchema.safeParse({ ...defaults, first_name: 'Contact', email: '   ' }).success, true);
});

test('provides clean create defaults and pre-fills nullable fields when editing', () => {
  assert.deepEqual(contactFormDefaults(null), {
    first_name: '', last_name: '', phone: '', email: '', whatsapp_number: '', status: 'lead',
    assigned_user_id: '', source: '', notes: '',
  });
  assert.deepEqual(contactFormDefaults(contacts[0]), {
    first_name: 'Équipe', last_name: 'Démo A', phone: '000-000-0001', email: 'equipe@example.test',
    whatsapp_number: '000-000-0001', status: 'prospect', assigned_user_id: 'agent-1',
    source: 'Recommandation', notes: '',
  });
  assert.equal(formatContactName(contacts[0]), 'Équipe Démo A');
  assert.equal(formatContactName(contacts[1]), 'Contact B');
  assert.equal(formatContactName({ first_name: '  ', last_name: null }), 'Nom non renseigné');
});

test('shows only opportunities whose existing client_id matches the contact', () => {
  const opportunities = [
    { id: 'deal-a', client_id: 'contact-a', property_id: 'property-1' },
    { id: 'deal-b', client_id: 'contact-b', property_id: 'property-2' },
    { id: 'deal-c', client_id: 'contact-a', property_id: 'property-3' },
  ];
  assert.deepEqual(
    linkedOpportunitiesForContact(opportunities, 'contact-a').map(({ id }) => id),
    ['deal-a', 'deal-c'],
  );
  assert.deepEqual(linkedOpportunitiesForContact(opportunities, null), []);
});
