export const MAX_PROPERTY_IMAGE_SIZE = 10 * 1024 * 1024;
export const SUPPORTED_PROPERTY_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
]);

export function validatePropertyImage(file) {
  if (!SUPPORTED_PROPERTY_IMAGE_TYPES.has(file.type)) {
    throw new Error('Utilisez une image JPG, PNG ou WebP.');
  }
  if (!Number.isFinite(file.size) || file.size <= 0) {
    throw new Error('Le fichier sélectionné est vide ou invalide.');
  }
  if (file.size > MAX_PROPERTY_IMAGE_SIZE) {
    throw new Error('Chaque image doit peser 10 Mo maximum.');
  }
}

export function propertyImageFileName(name) {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 100) || 'photo';
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function propertyImageObjectPath(agencyId, propertyId, fileName, objectId = globalThis.crypto.randomUUID()) {
  if (!UUID_PATTERN.test(agencyId) || !UUID_PATTERN.test(propertyId) || !UUID_PATTERN.test(objectId)) {
    throw new Error('Le chemin photo exige des identifiants UUID valides pour l’agence, le bien et le fichier.');
  }
  return `agencies/${agencyId}/properties/${propertyId}/${objectId}-${propertyImageFileName(fileName)}`;
}

export function propertyStorageUploadFailureAction(error) {
  const status = error && typeof error === 'object' ? error.status : undefined;
  if (Number.isInteger(status) && status >= 400 && status < 500) {
    return 'do-not-clean';
  }
  return 'cleanup-possible-object';
}

const POSTGRES_SQLSTATE_CLASSES = new Set([
  '00', '01', '02', '08', '09', '0A', '0B', '0F', '0L', '0P', '0Z',
  '10', '20', '21', '22', '23', '24', '25', '26', '27', '28', '2B',
  '2D', '2F', '34', '38', '39', '3B', '3D', '3F', '40', '42', '44',
  '53', '54', '55', '57', '58', 'F0', 'HV', 'P0', 'XX',
]);

const isDefinitivePostgrestErrorCode = (code) =>
  typeof code === 'string' && (
    (/^[0-9A-Z]{5}$/.test(code) && POSTGRES_SQLSTATE_CLASSES.has(code.slice(0, 2)))
    || /^PGRST\d{3}$/i.test(code)
  );

/**
 * Decide whether a failed metadata INSERT can safely compensate by deleting
 * the uploaded object. Transport errors are ambiguous: retain the object if
 * the metadata check also cannot prove that the INSERT failed.
 */
export function propertyDeleteFailureAction({ rowFound, verificationFailed, errorCode }) {
  if (rowFound || verificationFailed || isDefinitivePostgrestErrorCode(errorCode)) {
    return 'preserve-error';
  }
  return 'treat-as-deleted';
}

export function propertyMediaDeleteStorageAction({
  targetMediaId,
  linkedMediaIds,
  verificationFailed,
}) {
  if (verificationFailed || !Array.isArray(linkedMediaIds)) return 'preserve-for-review';
  if (linkedMediaIds.includes(targetMediaId)) return 'preserve-linked-metadata';
  if (linkedMediaIds.length > 0) return 'keep-referenced-object';
  return 'remove-unlinked-object';
}

export function propertyMediaInsertFailureAction({
  rowFound,
  verificationFailed,
  insertErrorCode,
}) {
  if (rowFound) return 'registered';
  if (verificationFailed || !isDefinitivePostgrestErrorCode(insertErrorCode)) {
    return 'preserve-for-review';
  }
  return 'cleanup-orphan';
}
