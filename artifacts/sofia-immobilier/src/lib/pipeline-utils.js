import { normalizeContactSearch } from './contact-utils.js';
import { visitDateBucket, visitDateKey } from './visit-utils.js';

export function pipelineStageLabel(value) {
  const stage = String(value ?? '').trim();
  return stage || 'Étape non renseignée';
}

export function normalizePipelineSearch(value) {
  return normalizeContactSearch(value);
}

export function getPipelineStages(opportunities) {
  return [...new Set(opportunities.map((item) => pipelineStageLabel(item.etape)))].sort((a, b) => a.localeCompare(b, 'fr'));
}

export function getPipelineStageCounts(opportunities) {
  const counts = new Map();
  for (const item of opportunities) {
    const stage = pipelineStageLabel(item.etape);
    counts.set(stage, (counts.get(stage) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([stage, count]) => ({ stage, count }))
    .sort((a, b) => a.stage.localeCompare(b.stage, 'fr'));
}

export function groupPipelineByStage(opportunities) {
  const groups = new Map();
  for (const item of opportunities) {
    const stage = pipelineStageLabel(item.etape);
    const group = groups.get(stage) ?? [];
    group.push(item);
    groups.set(stage, group);
  }
  return [...groups.entries()]
    .map(([stage, items]) => ({ stage, items }))
    .sort((a, b) => a.stage.localeCompare(b.stage, 'fr'));
}

export function pipelineDateRangeError(fromValue, toValue) {
  const fromText = String(fromValue ?? '').trim();
  const toText = String(toValue ?? '').trim();
  const from = fromText ? visitDateKey(fromText) : null;
  const to = toText ? visitDateKey(toText) : null;
  if (fromText && !from) return 'La date de début n’est pas valide.';
  if (toText && !to) return 'La date de fin n’est pas valide.';
  if (from && to && from > to) return 'La date de début ne peut pas dépasser la date de fin.';
  return null;
}

export function filterPipelineItems(opportunities, contacts, properties, filters = {}) {
  if (pipelineDateRangeError(filters.dateFrom, filters.dateTo)) return [];
  const rawSearch = String(filters.search ?? '').trim();
  const search = normalizePipelineSearch(rawSearch);
  const phoneSearch = rawSearch.replace(/\D/g, '');
  const searchIsPhone = /^[+\d\s().-]+$/.test(rawSearch) && phoneSearch.length >= 3;
  const stage = filters.stage ?? 'all';
  const assignedUserId = filters.assignedUserId ?? 'all';
  const datePresence = filters.datePresence ?? 'all';
  const from = filters.dateFrom ? visitDateKey(filters.dateFrom) : null;
  const to = filters.dateTo ? visitDateKey(filters.dateTo) : null;
  const contactsById = new Map(contacts.map((contact) => [contact.id, contact]));
  const propertiesById = new Map(properties.map((property) => [property.id, property]));

  return opportunities.filter((item) => {
    const contact = contactsById.get(item.client_id);
    const property = propertiesById.get(item.property_id);
    const searchableText = normalizePipelineSearch([
      item.etape,
      item.notes,
      contact?.first_name,
      contact?.last_name,
      contact?.phone,
      contact?.email,
      contact?.whatsapp_number,
      property?.reference,
      property?.title,
      property?.neighborhood,
      property?.city,
    ].filter(Boolean).join(' '));
    const phoneMatches = searchIsPhone && [contact?.phone, contact?.whatsapp_number]
      .some((value) => String(value ?? '').replace(/\D/g, '').includes(phoneSearch));
    const searchMatches = !search || searchableText.includes(search) || phoneMatches;
    const stageMatches = stage === 'all' || pipelineStageLabel(item.etape) === stage;
    const assigneeMatches = assignedUserId === 'all'
      || (assignedUserId === 'unassigned'
        ? Boolean(contact) && !contact.assigned_user_id
        : contact?.assigned_user_id === assignedUserId);
    const hasDate = Boolean(item.date_visite?.trim());
    const visitDate = hasDate ? visitDateKey(item.date_visite) : null;
    const datePresenceMatches = datePresence === 'all'
      || (datePresence === 'scheduled' && Boolean(visitDate))
      || (datePresence === 'unscheduled' && !hasDate);
    const dateRangeMatches = (!from && !to)
      || Boolean(visitDate && (!from || visitDate >= from) && (!to || visitDate <= to));
    return searchMatches && stageMatches && assigneeMatches && datePresenceMatches && dateRangeMatches;
  });
}

export function partitionPipelineVisits(opportunities, today) {
  const scheduledVisits = [];
  const unscheduledItems = [];
  let invalidDateCount = 0;

  for (const item of opportunities) {
    if (!item.date_visite?.trim()) {
      unscheduledItems.push(item);
      continue;
    }
    const dateKey = visitDateKey(item.date_visite);
    if (!dateKey) {
      invalidDateCount += 1;
      continue;
    }
    const bucket = visitDateBucket(dateKey, today);
    if (bucket) scheduledVisits.push({ item, dateKey, bucket });
  }

  return {
    scheduledVisits,
    unscheduledItems,
    invalidDateCount,
    todayCount: scheduledVisits.filter((visit) => visit.bucket === 'today').length,
    upcomingCount: scheduledVisits.filter((visit) => visit.bucket === 'upcoming').length,
    pastCount: scheduledVisits.filter((visit) => visit.bucket === 'past').length,
  };
}

export function nextPipelineVisits(scheduledVisits, limit = 5) {
  return [...scheduledVisits]
    .filter((visit) => visit.bucket === 'today' || visit.bucket === 'upcoming')
    .sort((left, right) => left.dateKey.localeCompare(right.dateKey)
      || right.item.created_at.localeCompare(left.item.created_at))
    .slice(0, Math.max(0, limit));
}
