export declare const AUTH_PHASES: Readonly<{
  SIGNUP: 'signup';
  SESSION_RESTORE: 'session-restore';
  SIGNIN: 'signin';
  SIGNOUT: 'signout';
}>;

export type AuthPhase = (typeof AUTH_PHASES)[keyof typeof AUTH_PHASES];

export declare const AUTH_ERROR_CATEGORIES: Readonly<{
  SIGNUP: 'signup-error';
  SESSION_RECOVERY: 'session-recovery-error';
  AUTHENTICATION: 'authentication-error';
}>;

export type AuthErrorCategory =
  (typeof AUTH_ERROR_CATEGORIES)[keyof typeof AUTH_ERROR_CATEGORIES];

export type AuthErrorCode =
  | 'user-already-registered'
  | 'weak-password'
  | 'invalid-email'
  | 'email-not-confirmed'
  | 'invalid-credentials'
  | 'captcha-failed'
  | 'signup-disabled'
  | 'rate-limited'
  | 'session-missing'
  | 'session-user-missing'
  | 'refresh-token-invalid'
  | 'session-expired'
  | 'network'
  | 'unknown';

export interface AuthDiagnostic {
  phase: AuthPhase;
  category: AuthErrorCategory;
  code: AuthErrorCode;
  userMessage: string;
  technicalDetail: string;
}

export declare function authErrorCategory(phase: AuthPhase): AuthErrorCategory;
export declare function classifyAuthError(error: unknown): AuthErrorCode;
export declare function diagnoseAuthError(
  error: unknown,
  phase?: AuthPhase,
): AuthDiagnostic;

export declare class AuthFlowError extends Error {
  constructor(diagnostic: AuthDiagnostic, options?: { cause?: unknown });
  diagnostic: AuthDiagnostic;
}

export declare function toAuthFlowError(
  error: unknown,
  phase?: AuthPhase,
): AuthFlowError;
