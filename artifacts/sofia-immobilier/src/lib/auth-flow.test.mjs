import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resolveSignupOutcome,
  runSignupFlow,
  verifySessionBeforeRedirect,
} from './auth-flow.js';
import { AUTH_ERROR_CATEGORIES, AuthFlowError } from './auth-diagnostics.js';

const session = (id = 'user-1') => ({ user: { id } });

test('uses the session returned by signUp() when the provider confirms immediately', () => {
  const outcome = resolveSignupOutcome({ session: session('user-42'), user: { id: 'user-42' } });
  assert.equal(outcome.status, 'session-active');
  assert.equal(outcome.userId, 'user-42');
  assert.equal(outcome.readyToRedirect, false);
});

test('reports email confirmation when signUp() returns a user without a session', () => {
  const outcome = resolveSignupOutcome({ session: null, user: { id: 'user-9' } });
  assert.equal(outcome.status, 'email-confirmation-required');
  assert.equal(outcome.userId, 'user-9');
  assert.equal(outcome.readyToRedirect, false);
});

test('flags incomplete signUp() payloads instead of guessing', () => {
  assert.equal(resolveSignupOutcome(null).status, 'incomplete');
  assert.equal(resolveSignupOutcome({}).status, 'incomplete');
  assert.equal(resolveSignupOutcome({ session: null, user: null }).status, 'incomplete');
  assert.equal(resolveSignupOutcome({ session: {}, user: null }).status, 'incomplete');
});

test('accepts a restored session with a user before redirecting', () => {
  const verification = verifySessionBeforeRedirect({ data: { session: session('user-7') }, error: null });
  assert.deepEqual(verification, { ok: true, userId: 'user-7' });
});

test('rejects redirect when session recovery returned an error', () => {
  const verification = verifySessionBeforeRedirect({
    data: { session: null },
    error: new Error('Invalid Refresh Token: Refresh Token Not Found'),
  });
  assert.equal(verification.ok, false);
  assert.equal(verification.reason, 'session-recovery-failed');
  assert.equal(verification.diagnostic.category, AUTH_ERROR_CATEGORIES.SESSION_RECOVERY);
  assert.equal(verification.diagnostic.code, 'refresh-token-invalid');
});

test('rejects redirect when no session was restored at all', () => {
  const verification = verifySessionBeforeRedirect({ data: { session: null }, error: null });
  assert.equal(verification.ok, false);
  assert.equal(verification.reason, 'session-missing');
  assert.equal(verification.diagnostic.phase, 'session-restore');
});

test('rejects redirect when the restored session carries no user', () => {
  const verification = verifySessionBeforeRedirect({ data: { session: { user: null } }, error: null });
  assert.equal(verification.ok, false);
  assert.equal(verification.reason, 'session-user-missing');
  assert.equal(verification.diagnostic.code, 'session-user-missing');
});

test('redirects only after signUp session has been restored and verified', async () => {
  const calls = [];
  const result = await runSignupFlow(
    {
      signUp: async (credentials) => {
        calls.push(['signUp', credentials.email]);
        return { data: { session: session('user-42'), user: { id: 'user-42' } }, error: null };
      },
      verifySession: async () => {
        calls.push(['verifySession']);
        return { ok: true, userId: 'user-42' };
      },
    },
    { email: 'agent@example.test', password: 'secret-pass' },
  );

  assert.deepEqual(calls, [['signUp', 'agent@example.test'], ['verifySession']]);
  assert.equal(result.status, 'session-active');
  assert.equal(result.readyToRedirect, true);
  assert.equal(result.userId, 'user-42');
});

test('never verifies a session when signUp() requires email confirmation', async () => {
  let verifyCalls = 0;
  const result = await runSignupFlow(
    {
      signUp: async () => ({ data: { session: null, user: { id: 'user-9' } }, error: null }),
      verifySession: async () => {
        verifyCalls += 1;
        return { ok: true, userId: 'user-9' };
      },
    },
    { email: 'agent@example.test', password: 'secret-pass' },
  );

  assert.equal(verifyCalls, 0);
  assert.equal(result.status, 'email-confirmation-required');
  assert.equal(result.readyToRedirect, false);
});

test('blocks the redirect and reports a session-recovery error when verification fails after signup', async () => {
  await assert.rejects(
    runSignupFlow(
      {
        signUp: async () => ({ data: { session: session('user-42'), user: { id: 'user-42' } }, error: null }),
        verifySession: async () => ({ ok: false, reason: 'session-missing' }),
      },
      { email: 'agent@example.test', password: 'secret-pass' },
    ),
    (error) => {
      assert.ok(error instanceof AuthFlowError);
      assert.equal(error.diagnostic.phase, 'session-restore');
      assert.equal(error.diagnostic.category, AUTH_ERROR_CATEGORIES.SESSION_RECOVERY);
      assert.notEqual(error.diagnostic.category, AUTH_ERROR_CATEGORIES.SIGNUP);
      return true;
    },
  );
});

test('reports thrown verification failures as session-recovery errors', async () => {
  await assert.rejects(
    runSignupFlow(
      {
        signUp: async () => ({ data: { session: session('user-42'), user: { id: 'user-42' } }, error: null }),
        verifySession: async () => {
          throw new Error('Auth session missing!');
        },
      },
      { email: 'agent@example.test', password: 'secret-pass' },
    ),
    (error) => {
      assert.ok(error instanceof AuthFlowError);
      assert.equal(error.diagnostic.phase, 'session-restore');
      assert.equal(error.diagnostic.code, 'session-missing');
      return true;
    },
  );
});

test('wraps signUp() rejections as signup diagnostics', async () => {
  await assert.rejects(
    runSignupFlow(
      {
        signUp: async () => {
          throw new Error('User already registered');
        },
        verifySession: async () => ({ ok: true, userId: 'user-1' }),
      },
      { email: 'agent@example.test', password: 'secret-pass' },
    ),
    (error) => {
      assert.ok(error instanceof AuthFlowError);
      assert.equal(error.diagnostic.phase, 'signup');
      assert.equal(error.diagnostic.category, AUTH_ERROR_CATEGORIES.SIGNUP);
      assert.equal(error.diagnostic.code, 'user-already-registered');
      return true;
    },
  );

  await assert.rejects(
    runSignupFlow(
      {
        signUp: async () => ({ data: null, error: new Error('Password should be at least 6 characters') }),
        verifySession: async () => ({ ok: true, userId: 'user-1' }),
      },
      { email: 'agent@example.test', password: 'short' },
    ),
    (error) => {
      assert.ok(error instanceof AuthFlowError);
      assert.equal(error.diagnostic.code, 'weak-password');
      assert.equal(error.diagnostic.category, AUTH_ERROR_CATEGORIES.SIGNUP);
      return true;
    },
  );
});
