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
import { getSupabaseClient, getSupabaseErrorMessage, supabaseConfigured } from './supabase';

interface AuthContextValue {
  user: User | null;
  session: Session | null;
  loading: boolean;
  configurationError: string | null;
  initializationError: string | null;
  signIn: (email: string, password: string) => Promise<User | null>;
  signUp: (email: string, password: string) => Promise<void>;
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
      setInitializationError(getSupabaseErrorMessage(error, 'initialiser la connexion'));
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
        setInitializationError(getSupabaseErrorMessage(error, 'charger la session'));
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

  const signIn = useCallback(async (email: string, password: string) => {
    const cleanEmail = email.trim().toLowerCase();
    const client = getSupabaseClient();
    let { data, error } = await client.auth.signInWithPassword({
      email: cleanEmail,
      password,
    });
    // Tolérance mobile / copier-coller : si un espace parasite entoure le mot de passe,
    // on retente une seule fois sans toucher aux mots de passe contenant volontairement un espace interne.
    if (
      error &&
      error.message?.toLowerCase().includes('invalid login credentials') &&
      password !== password.trim() &&
      password.trim().length > 0
    ) {
      const retry = await client.auth.signInWithPassword({
        email: cleanEmail,
        password: password.trim(),
      });
      data = retry.data;
      error = retry.error;
    }
    if (error) throw error;
    if (data.session) {
      queryClient.clear();
      previousUserId.current = data.session.user.id;
      setSession(data.session);
      setInitializationError(null);
    }
    return data.user ?? null;
  }, [queryClient]);

  const signUp = useCallback(async (email: string, password: string) => {
    const cleanEmail = email.trim().toLowerCase();
    const { data, error } = await getSupabaseClient().auth.signUp({ email: cleanEmail, password });
    if (error) throw error;
    // Si la confirmation d'e-mail est désactivée (mailer_autoconfirm), la session
    // est immédiatement active. Sinon, aucun user n'est renvoyé : l'écran d'inscription
    // affichera alors l'étape « vérifiez votre boîte mail ».
    if (data.session) {
      queryClient.clear();
      setSession(data.session);
    }
  }, [queryClient]);

  const signOut = useCallback(async () => {
    const { error } = await getSupabaseClient().auth.signOut({ scope: 'local' });
    if (error) throw error;
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
    signOut,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth doit être utilisé dans AuthProvider.');
  return context;
}
