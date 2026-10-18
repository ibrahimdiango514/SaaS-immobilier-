export function normalizeContactSearch(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase('fr');
}

export function formatContactName(contact) {
  const name = [contact?.first_name, contact?.last_name]
    .filter((part) => typeof part === 'string')
    .map((part) => part.trim())
    .filter(Boolean)
    .join(' ');
  return name || 'Nom non renseigné';
}

export function getAssignableContactMembers(members) {
  return members.filter((member) => member.status === 'active' && member.role !== 'viewer');
}

export function canAssignContactToMember(userId, members, existingAssigneeId = null) {
  if (!userId || userId === existingAssigneeId) return true;
  return getAssignableContactMembers(members).some((member) => member.user_id === userId);
}

export function contactFormDefaults(item) {
  return {
    first_name: item?.first_name ?? '',
    last_name: item?.last_name ?? '',
    phone: item?.phone ?? '',
    email: item?.email ?? '',
    whatsapp_number: item?.whatsapp_number ?? '',
    status: item?.status ?? 'lead',
    assigned_user_id: item?.assigned_user_id ?? '',
    source: item?.source ?? '',
    notes: item?.notes ?? '',
  };
}

export function filterContacts(contacts, filters = {}) {
  const rawSearch = String(filters.search ?? '').trim();
  const search = normalizeContactSearch(rawSearch);
  const phoneSearch = rawSearch.replace(/\D/g, '');
  const searchIsPhone = /^[+\d\s().-]+$/.test(rawSearch) && phoneSearch.length >= 3;
  const status = filters.status ?? 'all';
  const assignedUserId = filters.assignedUserId ?? 'all';

  return contacts.filter((contact) => {
    const searchableText = normalizeContactSearch([
      contact.first_name,
      contact.last_name,
      contact.phone,
      contact.email,
      contact.whatsapp_number,
      contact.source,
      contact.status,
    ].filter(Boolean).join(' '));
    const phoneMatches = searchIsPhone && [contact.phone, contact.whatsapp_number]
      .some((value) => String(value ?? '').replace(/\D/g, '').includes(phoneSearch));
    const searchMatches = !search || searchableText.includes(search) || phoneMatches;
    const statusMatches = status === 'all' || contact.status === status;
    const assigneeMatches = assignedUserId === 'all'
      || (assignedUserId === 'unassigned' ? !contact.assigned_user_id : contact.assigned_user_id === assignedUserId);
    return searchMatches && statusMatches && assigneeMatches;
  });
}

export function linkedOpportunitiesForContact(opportunities, contactId) {
  if (!contactId) return [];
  return opportunities.filter((opportunity) => opportunity.client_id === contactId);
}
