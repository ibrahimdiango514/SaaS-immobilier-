import { useState } from 'react';
import { Moon, Sun } from 'lucide-react';

export type ThemeMode = 'light' | 'dark';

const THEME_KEY = 'sofia-theme';

export function getTheme(): ThemeMode {
  if (typeof document === 'undefined') return 'light';
  const attribute = document.documentElement.dataset.theme;
  if (attribute === 'dark' || attribute === 'light') return attribute;
  try {
    return localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

export function applyTheme(mode: ThemeMode) {
  document.documentElement.dataset.theme = mode;
  try {
    localStorage.setItem(THEME_KEY, mode);
  } catch {
    /* stockage indisponible : le thème s’applique quand même pour la session */
  }
}

export function ThemeToggle({ testId = 'button-theme-toggle' }: { testId?: string }) {
  const [theme, setTheme] = useState<ThemeMode>(() => getTheme());
  const toggle = () => {
    const next: ThemeMode = theme === 'light' ? 'dark' : 'light';
    applyTheme(next);
    setTheme(next);
  };
  return (
    <button
      type="button"
      className="icon-button theme-toggle"
      onClick={toggle}
      aria-label={theme === 'light' ? 'Activer le mode sombre' : 'Activer le mode clair'}
      title={theme === 'light' ? 'Mode sombre' : 'Mode clair'}
      data-testid={testId}
    >
      {theme === 'light' ? <Moon size={15} /> : <Sun size={15} />}
    </button>
  );
}
