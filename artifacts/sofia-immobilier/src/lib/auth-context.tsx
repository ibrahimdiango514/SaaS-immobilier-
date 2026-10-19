import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Session, User } from '@supabase/supabase-js';
import { getSupabaseClient, supabaseConfigured } from './supabase';
import {
  runSignupFlow,
  verifySessionBeforeRedirect,
  type SignupCredentials,
  type SignupOutcome,
  type SessionVerification,
} from './auth-flow.js';
import { AUTH_PHASES, diagnoseAuthError, toAuthFlowError } from './auth-diagnostics.js';

export type { SignupOutcome, SessionVerification };

interface AuthContextValue {
  user: User | null;
  session: Session | null;
  loading: boolean;
  configurationError: string | null;
  initializationError: string | null;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string, profile?: { fullName?: string }) => Promise<SignupOutcome>;
  verifySessionReady: () => Promise<SessionVerification>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [initializationError, setInitializationError] = useState<string | null>(null);
  const previousUserId = useRef<string | null>(null);

  useEffect(() => {
    if (!supabaseConfigured) {
      setLoading(false);
      return undefined;
    }

    let mounted = true;
    let supabase;

    try {
      supabase = getSupabaseClient();
    } catch (error) {
      setInitializationError(diagnoseAuthError(error, AUTH_PHASES.SESSION_RESTORE).userMessage);
      setLoading(false);
      return undefined;
    }

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      if (!mounted) return;
      const nextUserId = nextSession?.user.id ?? null;
      if (previousUserId.current !== nextUserId) {
        queryClient.clear();
        previousUserId.current = nextUserId;
      }
      setSession(nextSession);
      setInitializationError(null);
      setLoading(false);
    });

    void supabase.auth.getSession().then(({ data, error }) => {
      if (!mounted) return;
      if (error) {
        // Session recovery problems are diagnosed apart from signup failures.
        setInitializationError(diagnoseAuthError(error, AUTH_PHASES.SESSION_RESTORE).userMessage);
      } else {
        const nextUserId = data.session?.user.id ?? null;
        if (previousUserId.current !== nextUserId) {
          queryClient.clear();
          previousUserId.current = nextUserId;
        }
        setSession(data.session);
      }
      setLoading(false);
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, [queryClient]);

  const verifySessionReady = useCallback(async (): Promise<SessionVerification> => {
    let result;
    try {
      result = await getSupabaseClient().auth.getSession();
    } catch (error) {
      return {
        ok: false,
        reason: 'session-recovery-failed',
        diagnostic: diagnoseAuthError(error, AUTH_PHASES.SESSION_RESTORE),
      };
    }

    const verification = verifySessionBeforeRedirect(result);
    if (!verification.ok) return verification;

    // Align React state with the verified session before any redirect happens.
    setSession(result.data.session ?? null);
    return verification;
  }, []);

  const signUp = useCallback(
    async (email: string, password: string, profile?: { fullName?: string }): Promise<SignupOutcome> => {
      const credentials: SignupCredentials = {
        email,
        password,
        ...(profile?.fullName ? { fullName: profile.fullName } : {}),
      };

      return runSignupFlow(
        {
          signUp: async (input) => {
            const { data, error } = await getSupabaseClient().auth.signUp({
              email: input.email,
              password: input.password,
              options: {
                data: input.fullName ? { full_name: input.fullName } : {},
              },
            });
            return { data, error };
          },
          verifySession: verifySessionReady,
        },
        credentials,
      );
    },
    [verifySessionReady],
  );

  const signIn = useCallback(async (email: string, password: string) => {
    try {
      const { error } = await getSupabaseClient().auth.signInWithPassword({ email, password });
      if (error) throw error;
    } catch (error) {
      throw toAuthFlowError(error, AUTH_PHASES.SIGNIN);
    }
  }, []);

  const signOut = useCallback(async () => {
    try {
      const { error } = await getSupabaseClient().auth.signOut({ scope: 'local' });
      if (error) throw error;
    } catch (error) {
      throw toAuthFlowError(error, AUTH_PHASES.SIGNOUT);
    }
    queryClient.clear();
    setSession(null);
  }, [queryClient]);

  const value: AuthContextValue = {
    user: session?.user ?? null,
    session,
    loading,
    configurationError: supabaseConfigured
      ? null
      : 'La configuration Supabase manque. Les données de l’agence ne peuvent pas être chargées.',
    initializationError,
    signIn,
    signUp,
    verifySessionReady,
    signOut,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth doit être utilisé dans AuthProvider.');
  return context;
}
