import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AUTH_ERROR_CATEGORIES,
  AUTH_PHASES,
  AuthFlowError,
  authErrorCategory,
  classifyAuthError,
  diagnoseAuthError,
  toAuthFlowError,
} from './auth-diagnostics.js';

test('keeps signup failures in the signup category, never in session recovery', () => {
  const diagnostic = diagnoseAuthError(
    new Error('User already registered'),
    AUTH_PHASES.SIGNUP,
  );
  assert.equal(diagnostic.phase, 'signup');
  assert.equal(diagnostic.category, AUTH_ERROR_CATEGORIES.SIGNUP);
  assert.notEqual(diagnostic.category, AUTH_ERROR_CATEGORIES.SESSION_RECOVERY);
  assert.equal(diagnostic.code, 'user-already-registered');
  assert.match(diagnostic.userMessage, /compte existe déjà/i);
});

test('classifies weak password and invalid email signup rejections', () => {
  const weak = diagnoseAuthError(
    new Error('Password should be at least 6 characters'),
    AUTH_PHASES.SIGNUP,
  );
  assert.equal(weak.code, 'weak-password');
  assert.equal(weak.category, AUTH_ERROR_CATEGORIES.SIGNUP);

  const invalidEmail = diagnoseAuthError(
    new Error('Unable to validate email address: invalid format'),
    AUTH_PHASES.SIGNUP,
  );
  assert.equal(invalidEmail.code, 'invalid-email');
  assert.match(invalidEmail.userMessage, /e-mail/i);
});

test('reads modern Supabase error codes in addition to message text', () => {
  const diagnostic = diagnoseAuthError(
    { code: 'user_already_exists', message: 'Database error saving new user' },
    AUTH_PHASES.SIGNUP,
  );
  assert.equal(diagnostic.code, 'user-already-registered');
});

test('keeps session restore failures in the session-recovery category', () => {
  const missing = diagnoseAuthError(
    new Error('Auth session missing!'),
    AUTH_PHASES.SESSION_RESTORE,
  );
  assert.equal(missing.phase, 'session-restore');
  assert.equal(missing.category, AUTH_ERROR_CATEGORIES.SESSION_RECOVERY);
  assert.equal(missing.code, 'session-missing');
  assert.match(missing.userMessage, /session/i);

  const refresh = diagnoseAuthError(
    new Error('Invalid Refresh Token: Refresh Token Not Found'),
    AUTH_PHASES.SESSION_RESTORE,
  );
  assert.equal(refresh.code, 'refresh-token-invalid');
  assert.equal(refresh.category, AUTH_ERROR_CATEGORIES.SESSION_RECOVERY);
});

test('diagnoses expired sessions during restore with their own recovery message', () => {
  const expired = diagnoseAuthError(
    new Error('JWT expired'),
    AUTH_PHASES.SESSION_RESTORE,
  );
  assert.equal(expired.code, 'session-expired');
  assert.equal(expired.category, AUTH_ERROR_CATEGORIES.SESSION_RECOVERY);
  assert.match(expired.userMessage, /expir/i);
});

test('reports the same unknown error differently for signup and session restore', () => {
  const shared = new Error('Unexpected upstream failure');
  const duringSignup = diagnoseAuthError(shared, AUTH_PHASES.SIGNUP);
  const duringRestore = diagnoseAuthError(shared, AUTH_PHASES.SESSION_RESTORE);

  assert.equal(duringSignup.category, AUTH_ERROR_CATEGORIES.SIGNUP);
  assert.equal(duringRestore.category, AUTH_ERROR_CATEGORIES.SESSION_RECOVERY);
  assert.notEqual(duringSignup.userMessage, duringRestore.userMessage);
  assert.match(duringSignup.userMessage, /créer le compte/i);
  assert.match(duringRestore.userMessage, /restaurer/i);
  assert.equal(duringSignup.technicalDetail, shared.message);
  assert.equal(duringRestore.technicalDetail, shared.message);
});

test('classifies sign-in credential errors as plain authentication errors', () => {
  const diagnostic = diagnoseAuthError(
    new Error('Invalid login credentials'),
    AUTH_PHASES.SIGNIN,
  );
  assert.equal(diagnostic.code, 'invalid-credentials');
  assert.equal(diagnostic.category, AUTH_ERROR_CATEGORIES.AUTHENTICATION);
  assert.equal(authErrorCategory(AUTH_PHASES.SIGNIN), AUTH_ERROR_CATEGORIES.AUTHENTICATION);
  assert.equal(authErrorCategory(AUTH_PHASES.SIGNOUT), AUTH_ERROR_CATEGORIES.AUTHENTICATION);
});

test('maps network and rate-limit failures for both signup and restore phases', () => {
  const networkSignup = diagnoseAuthError(new TypeError('Failed to fetch'), AUTH_PHASES.SIGNUP);
  const networkRestore = diagnoseAuthError(new TypeError('Failed to fetch'), AUTH_PHASES.SESSION_RESTORE);
  assert.equal(networkSignup.code, 'network');
  assert.equal(networkRestore.code, 'network');
  assert.equal(networkSignup.category, AUTH_ERROR_CATEGORIES.SIGNUP);
  assert.equal(networkRestore.category, AUTH_ERROR_CATEGORIES.SESSION_RECOVERY);

  const rateLimited = diagnoseAuthError(
    new Error('Request rate limited for security purposes'),
    AUTH_PHASES.SIGNUP,
  );
  assert.equal(rateLimited.code, 'rate-limited');
});

test('wraps plain errors into AuthFlowError carrying the diagnostic payload', () => {
  const wrapped = toAuthFlowError(new Error('User already registered'), AUTH_PHASES.SIGNUP);
  assert.ok(wrapped instanceof AuthFlowError);
  assert.equal(wrapped.diagnostic.phase, 'signup');
  assert.equal(wrapped.diagnostic.code, 'user-already-registered');
  assert.equal(wrapped.message, wrapped.diagnostic.userMessage);
});

test('keeps AuthFlowError instances untouched and defaults unknown phases to signup', () => {
  const original = toAuthFlowError(new Error('boom'), AUTH_PHASES.SIGNUP);
  assert.equal(toAuthFlowError(original, AUTH_PHASES.SESSION_RESTORE), original);

  const fallback = diagnoseAuthError(new Error('boom'), 'not-a-phase');
  assert.equal(fallback.phase, AUTH_PHASES.SIGNUP);
  assert.equal(fallback.category, AUTH_ERROR_CATEGORIES.SIGNUP);

  assert.equal(classifyAuthError(undefined), 'unknown');
});
