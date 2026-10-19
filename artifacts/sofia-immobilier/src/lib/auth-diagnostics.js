export const AUTH_PHASES = Object.freeze({
  SIGNUP: 'signup',
  SESSION_RESTORE: 'session-restore',
  SIGNIN: 'signin',
  SIGNOUT: 'signout',
});

export const AUTH_ERROR_CATEGORIES = Object.freeze({
  SIGNUP: 'signup-error',
  SESSION_RECOVERY: 'session-recovery-error',
  AUTHENTICATION: 'authentication-error',
});

export function authErrorCategory(phase) {
  if (phase === AUTH_PHASES.SIGNUP) return AUTH_ERROR_CATEGORIES.SIGNUP;
  if (phase === AUTH_PHASES.SESSION_RESTORE) return AUTH_ERROR_CATEGORIES.SESSION_RECOVERY;
  return AUTH_ERROR_CATEGORIES.AUTHENTICATION;
}

function errorSnapshot(error) {
  const candidate = error ?? {};
  return {
    code: typeof candidate.code === 'string' ? candidate.code.toLowerCase() : '',
    message: typeof candidate.message === 'string' ? candidate.message : String(error ?? ''),
  };
}

export function classifyAuthError(error) {
  const { code, message } = errorSnapshot(error);
  const text = message.toLowerCase();

  if (code === 'user_already_exists' || text.includes('already registered') || text.includes('already been registered')) {
    return 'user-already-registered';
  }
  if (code === 'weak_password' || text.includes('password should be at least') || text.includes('password is too easy') || text.includes('pwned')) {
    return 'weak-password';
  }
  if (code === 'validation_failed' || text.includes('unable to validate email') || text.includes('email address is invalid') || text.includes('invalid email')) {
    return 'invalid-email';
  }
  if (text.includes('email not confirmed') || text.includes('email not yet confirmed')) {
    return 'email-not-confirmed';
  }
  if (text.includes('invalid login credentials')) {
    return 'invalid-credentials';
  }
  if (text.includes('captcha')) {
    return 'captcha-failed';
  }
  if (text.includes('signups not allowed') || text.includes('signups not enabled') || text.includes('signup is disabled') || text.includes('user signups are disabled')) {
    return 'signup-disabled';
  }
  if (text.includes('rate limit') || text.includes('too many requests') || text.includes('security purposes')) {
    return 'rate-limited';
  }
  if (code === 'session_missing' || text.includes('auth session missing') || (text.includes('session') && text.includes('missing'))) {
    return 'session-missing';
  }
  if (code === 'session_user_missing' || text.includes('user from sub claim') || (text.includes('session') && text.includes('without user'))) {
    return 'session-user-missing';
  }
  if (text.includes('refresh token') || text.includes('invalid refresh') || text.includes('refresh_token')) {
    return 'refresh-token-invalid';
  }
  if (text.includes('jwt expired') || text.includes('token expired') || text.includes('session expired') || text.includes('expir')) {
    return 'session-expired';
  }
  if (text.includes('failed to fetch') || text.includes('networkerror') || text.includes('network request failed') || text.includes('load failed')) {
    return 'network';
  }
  return 'unknown';
}

const SIGNUP_MESSAGES = Object.freeze({
  'user-already-registered': 'Un compte existe déjà avec cette adresse e-mail. Connectez-vous ou utilisez une autre adresse.',
  'weak-password': 'Le mot de passe est trop faible. Choisissez-en un plus long et moins prévisible.',
  'invalid-email': 'L’adresse e-mail n’est pas valide.',
  'email-not-confirmed': 'Cette adresse e-mail n’a pas encore été confirmée. Consultez votre boîte mail.',
  'captcha-failed': 'La vérification anti-robot a échoué. Réessayez l’inscription.',
  'signup-disabled': 'Les inscriptions sont actuellement désactivées sur cet espace.',
  'rate-limited': 'Trop de tentatives d’inscription. Patientez puis réessayez.',
  network: 'Connexion impossible pendant l’inscription. Vérifiez votre accès réseau puis réessayez.',
  unknown: 'Impossible de créer le compte pour le moment. Réessayez ou contactez l’administrateur de votre espace.',
});

const SESSION_MESSAGES = Object.freeze({
  'session-missing': 'La session n’a pas pu être restaurée : aucune session active n’a été trouvée après l’opération. Reconnectez-vous.',
  'session-user-missing': 'La session restaurée ne référence aucun utilisateur. Reconnectez-vous pour continuer.',
  'refresh-token-invalid': 'La session restaurée n’est plus valide (jeton de rafraîchissement refusé). Reconnectez-vous.',
  'session-expired': 'La session restaurée a expiré avant d’être vérifiée. Reconnectez-vous pour continuer.',
  network: 'Connexion impossible pendant la restauration de la session. Vérifiez votre accès réseau puis réessayez.',
  'rate-limited': 'Trop de tentatives de restauration de session. Patientez puis réessayez.',
  unknown: 'Impossible de restaurer votre session après l’opération. Reconnectez-vous ou contactez l’administrateur de votre espace.',
});

const SIGNIN_MESSAGES = Object.freeze({
  'invalid-credentials': 'Adresse e-mail ou mot de passe incorrect.',
  'email-not-confirmed': 'Cette adresse e-mail n’a pas encore été confirmée.',
  'user-already-registered': 'Un compte existe déjà avec cette adresse e-mail.',
  network: 'Connexion impossible. Vérifiez votre accès réseau puis réessayez.',
  'rate-limited': 'Trop de tentatives de connexion. Patientez puis réessayez.',
  unknown: 'Impossible d’ouvrir une session pour le moment. Réessayez ou contactez l’administrateur de votre espace.',
});

function messageFor(phase, code, category) {
  const table = category === AUTH_ERROR_CATEGORIES.SIGNUP
    ? SIGNUP_MESSAGES
    : category === AUTH_ERROR_CATEGORIES.SESSION_RECOVERY
      ? SESSION_MESSAGES
      : SIGNIN_MESSAGES;
  return table[code] ?? table.unknown;
}

export function diagnoseAuthError(error, phase = AUTH_PHASES.SIGNUP) {
  const safePhase = Object.values(AUTH_PHASES).includes(phase) ? phase : AUTH_PHASES.SIGNUP;
  const category = authErrorCategory(safePhase);
  const code = classifyAuthError(error);
  const { message } = errorSnapshot(error);
  return {
    phase: safePhase,
    category,
    code,
    userMessage: messageFor(safePhase, code, category),
    technicalDetail: message.trim() || code || 'unknown error',
  };
}

export class AuthFlowError extends Error {
  constructor(diagnostic, options) {
    super(diagnostic?.userMessage ?? 'Erreur d’authentification.', options);
    this.name = 'AuthFlowError';
    this.diagnostic = diagnostic;
  }
}

export function toAuthFlowError(error, phase = AUTH_PHASES.SIGNUP) {
  if (error instanceof AuthFlowError) return error;
  return new AuthFlowError(diagnoseAuthError(error, phase), { cause: error });
}
