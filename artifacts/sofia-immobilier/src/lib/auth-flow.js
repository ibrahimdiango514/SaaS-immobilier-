import {
  AUTH_PHASES,
  AuthFlowError,
  diagnoseAuthError,
  toAuthFlowError,
} from './auth-diagnostics.js';

export function resolveSignupOutcome(signUpData) {
  const session = signUpData?.session ?? null;
  const user = signUpData?.user ?? null;

  if (session && session.user) {
    return {
      status: 'session-active',
      userId: session.user.id,
      readyToRedirect: false,
    };
  }
  if (user) {
    return {
      status: 'email-confirmation-required',
      userId: user.id ?? null,
      readyToRedirect: false,
    };
  }
  return {
    status: 'incomplete',
    userId: null,
    readyToRedirect: false,
  };
}

export function verifySessionBeforeRedirect(getSessionResult) {
  const error = getSessionResult?.error ?? null;
  const session = getSessionResult?.data?.session ?? null;

  if (error) {
    return {
      ok: false,
      reason: 'session-recovery-failed',
      diagnostic: diagnoseAuthError(error, AUTH_PHASES.SESSION_RESTORE),
    };
  }
  if (!session) {
    return {
      ok: false,
      reason: 'session-missing',
      diagnostic: diagnoseAuthError(
        { code: 'session_missing', message: 'Auth session missing!' },
        AUTH_PHASES.SESSION_RESTORE,
      ),
    };
  }
  if (!session.user) {
    return {
      ok: false,
      reason: 'session-user-missing',
      diagnostic: diagnoseAuthError(
        { code: 'session_user_missing', message: 'Session restored without user' },
        AUTH_PHASES.SESSION_RESTORE,
      ),
    };
  }
  return { ok: true, userId: session.user.id };
}

export async function runSignupFlow(dependencies, credentials) {
  const { signUp, verifySession } = dependencies;

  let result;
  try {
    result = await signUp(credentials);
  } catch (error) {
    throw toAuthFlowError(error, AUTH_PHASES.SIGNUP);
  }
  if (result?.error) {
    throw toAuthFlowError(result.error, AUTH_PHASES.SIGNUP);
  }

  const outcome = resolveSignupOutcome(result?.data);

  if (outcome.status !== 'session-active') {
    return { ...outcome, readyToRedirect: false };
  }

  let verification;
  try {
    verification = await verifySession();
  } catch (error) {
    throw toAuthFlowError(error, AUTH_PHASES.SESSION_RESTORE);
  }

  if (!verification?.ok) {
    const diagnostic =
      verification?.diagnostic ??
      diagnoseAuthError(
        { code: 'session_missing', message: 'Auth session missing!' },
        AUTH_PHASES.SESSION_RESTORE,
      );
    throw new AuthFlowError(diagnostic);
  }

  return {
    ...outcome,
    userId: verification.userId ?? outcome.userId,
    readyToRedirect: true,
  };
}
