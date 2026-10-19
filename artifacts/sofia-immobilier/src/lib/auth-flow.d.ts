import type { AuthDiagnostic, AuthFlowError } from './auth-diagnostics.js';

export type SignupStatus =
  | 'session-active'
  | 'email-confirmation-required'
  | 'incomplete';

export interface SignupOutcome {
  status: SignupStatus;
  userId: string | null;
  readyToRedirect: boolean;
}

export type SignupOutcomeInput = {
  session?: { user?: { id?: string } | null } | null;
  user?: { id?: string | null } | null;
} | null;

export declare function resolveSignupOutcome(
  signUpData: SignupOutcomeInput,
): { status: SignupStatus; userId: string | null; readyToRedirect: false };

export type SessionVerification =
  | { ok: true; userId: string }
  | { ok: false; reason: 'session-recovery-failed' | 'session-missing' | 'session-user-missing'; diagnostic: AuthDiagnostic };

export type GetSessionResultLike = {
  data?: { session?: { user?: { id?: string } | null } | null } | null;
  error?: unknown;
} | null;

export declare function verifySessionBeforeRedirect(
  getSessionResult: GetSessionResultLike,
): SessionVerification;

export type SignupCredentials = {
  email: string;
  password: string;
  fullName?: string;
};

export type SignUpResultLike = {
  data?: SignupOutcomeInput;
  error?: unknown;
};

export type SignupFlowDependencies = {
  signUp: (credentials: SignupCredentials) => Promise<SignUpResultLike>;
  verifySession: () => Promise<SessionVerification>;
};

export declare function runSignupFlow(
  dependencies: SignupFlowDependencies,
  credentials: SignupCredentials,
): Promise<SignupOutcome>;
export { AuthFlowError };
