import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_PROPERTY_IMAGE_SIZE,
  propertyDeleteFailureAction,
  propertyImageFileName,
  propertyImageObjectPath,
  propertyMediaDeleteStorageAction,
  propertyMediaInsertFailureAction,
  propertyStorageUploadFailureAction,
  validatePropertyImage,
} from './property-media-utils.js';

const validFile = (type = 'image/jpeg', size = 1) => ({ type, size });

test('accepts supported photo MIME types up to the 10 MiB boundary', () => {
  for (const type of ['image/jpeg', 'image/png', 'image/webp']) {
    assert.doesNotThrow(() => validatePropertyImage(validFile(type, MAX_PROPERTY_IMAGE_SIZE)));
  }
});

test('rejects unsupported MIME types, empty files, and files above 10 MiB', () => {
  assert.throws(() => validatePropertyImage(validFile('image/svg+xml')), /JPG, PNG ou WebP/);
  assert.throws(() => validatePropertyImage(validFile('image/png', 0)), /vide ou invalide/);
  assert.throws(() => validatePropertyImage(validFile('image/png', Number.NaN)), /vide ou invalide/);
  assert.throws(
    () => validatePropertyImage(validFile('image/png', MAX_PROPERTY_IMAGE_SIZE + 1)),
    /10 Mo maximum/,
  );
});

test('sanitizes filenames without path separators, traversal segments, or unbounded length', () => {
  assert.equal(propertyImageFileName('../été photo..jpg'), 'ete-photo.jpg');
  assert.equal(propertyImageFileName('....'), 'photo');
  assert.equal(propertyImageFileName('x'.repeat(140)).length, 100);
  assert.doesNotMatch(propertyImageFileName('../x\\y.png'), /[\\/]|\.\./);
});

test('builds a five-segment path scoped to agency and property IDs', () => {
  assert.equal(
    propertyImageObjectPath(
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
      'Photo été.jpg',
      '550e8400-e29b-41d4-a716-446655440000',
    ),
    'agencies/11111111-1111-4111-8111-111111111111/properties/22222222-2222-4222-8222-222222222222/550e8400-e29b-41d4-a716-446655440000-Photo-ete.jpg',
  );
});

test('rejects malformed agency, property, or object IDs before creating a storage path', () => {
  assert.throws(() => propertyImageObjectPath('', '22222222-2222-4222-8222-222222222222', 'x.jpg'), /UUID valides/);
  assert.throws(() => propertyImageObjectPath('11111111-1111-4111-8111-111111111111', 'not-a-uuid', 'x.jpg'), /UUID valides/);
  assert.throws(() => propertyImageObjectPath('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', 'x.jpg', 'not-a-uuid'), /UUID valides/);
});

test('does not delete a pre-existing object after a definitive upload rejection', () => {
  assert.equal(propertyStorageUploadFailureAction({ status: 409 }), 'do-not-clean');
  assert.equal(propertyStorageUploadFailureAction({ status: 403 }), 'do-not-clean');
  assert.equal(propertyStorageUploadFailureAction({}), 'cleanup-possible-object');
  assert.equal(propertyStorageUploadFailureAction(new TypeError('network failure')), 'cleanup-possible-object');
});

test('reconciles an ambiguous property-delete response without masking confirmed DB errors', () => {
  assert.equal(propertyDeleteFailureAction({ rowFound: false, verificationFailed: false }), 'treat-as-deleted');
  assert.equal(propertyDeleteFailureAction({ rowFound: true, verificationFailed: false }), 'preserve-error');
  assert.equal(propertyDeleteFailureAction({ rowFound: false, verificationFailed: true }), 'preserve-error');
  assert.equal(propertyDeleteFailureAction({ rowFound: false, verificationFailed: false, errorCode: '42501' }), 'preserve-error');
});

test('removes Storage only after metadata is gone and no remaining row references the object', () => {
  const targetMediaId = 'media-a';
  assert.equal(
    propertyMediaDeleteStorageAction({
      targetMediaId,
      linkedMediaIds: [targetMediaId],
      verificationFailed: false,
    }),
    'preserve-linked-metadata',
  );
  assert.equal(
    propertyMediaDeleteStorageAction({
      targetMediaId,
      linkedMediaIds: ['media-b'],
      verificationFailed: false,
    }),
    'keep-referenced-object',
  );
  assert.equal(
    propertyMediaDeleteStorageAction({
      targetMediaId,
      linkedMediaIds: [],
      verificationFailed: true,
    }),
    'preserve-for-review',
  );
  assert.equal(
    propertyMediaDeleteStorageAction({
      targetMediaId,
      linkedMediaIds: [],
      verificationFailed: false,
    }),
    'remove-unlinked-object',
  );
});

test('keeps an object when metadata status is ambiguous, and only cleans up after a confirmed DB rejection', () => {
  assert.equal(
    propertyMediaInsertFailureAction({ rowFound: true, verificationFailed: false, insertErrorCode: '42501' }),
    'registered',
  );
  assert.equal(
    propertyMediaInsertFailureAction({ rowFound: false, verificationFailed: false, insertErrorCode: '42501' }),
    'cleanup-orphan',
  );
  assert.equal(
    propertyMediaInsertFailureAction({ rowFound: false, verificationFailed: false, insertErrorCode: undefined }),
    'preserve-for-review',
  );
  assert.equal(
    propertyMediaInsertFailureAction({ rowFound: false, verificationFailed: true, insertErrorCode: '23514' }),
    'preserve-for-review',
  );
  assert.equal(
    propertyMediaInsertFailureAction({ rowFound: false, verificationFailed: false, insertErrorCode: 'ECONN' }),
    'preserve-for-review',
  );
});
