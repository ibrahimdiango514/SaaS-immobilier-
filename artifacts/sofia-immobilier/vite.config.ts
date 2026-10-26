import path from 'path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, loadEnv } from 'vite';

import runtimeErrorOverlay from '@replit/vite-plugin-runtime-error-modal';

const rawPort = process.env.PORT;

if (!rawPort) {
  throw new Error(
    'PORT environment variable is required but was not provided.',
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const basePath = process.env.BASE_PATH;

if (!basePath) {
  throw new Error(
    'BASE_PATH environment variable is required but was not provided.',
  );
}

// CORRECTIF — « Connexion indispensable : la configuration Supabase manque ».
// Cause : la config Vite prend `artifacts/sofia-immobilier` comme racine, donc
// Vite y cherche son `.env`. Ce fichier est ignoré par Git (.gitignore) et
// n'existe pas dans une preview fraîchement restaurée : les deux variables
// VITE_SOFIA_PUBLIC_* étaient donc absentes du bundle et TOUTE l'application
// affichait la carte d'erreur, alors que le code est correct.
// Repli appliqué UNIQUEMENT au serveur de développement (`vite serve`) : la
// clé ci-dessous est une clé PUBLIQUE, déjà publiée dans netlify.toml et dans
// .env.example, et protégée par les politiques RLS. Un `vite build` (Netlify)
// continue d'utiliser strictement les variables d'environnement fournies.
const devFallback = {
  VITE_SOFIA_PUBLIC_SUPABASE_URL: 'https://xbuuhfwobrafcbgtdgjx.supabase.co',
  VITE_SOFIA_PUBLIC_SUPABASE_KEY: 'sb_publishable_utbZhw8dg-2M1-g0nXIhfA_n6dZCDZz',
};

export default defineConfig(async ({ command, mode }) => {
  const definedEnv: Record<string, string> = {};
  if (command === 'serve') {
    const fileEnv = loadEnv(mode, path.resolve(import.meta.dirname), 'VITE_');
    for (const [key, fallback] of Object.entries(devFallback)) {
      const value = process.env[key] ?? fileEnv[key] ?? fallback;
      definedEnv[`import.meta.env.${key}`] = JSON.stringify(value);
    }
  }

  return {
  base: basePath,
  plugins: [
    react(),
    tailwindcss(),
    runtimeErrorOverlay(),
    ...(process.env.NODE_ENV !== 'production' &&
    process.env.REPL_ID !== undefined
      ? [
          await import('@replit/vite-plugin-cartographer').then((m) =>
            m.cartographer({
              root: path.resolve(import.meta.dirname, '..'),
            }),
          ),
          await import('@replit/vite-plugin-dev-banner').then((m) =>
            m.devBanner(),
          ),
        ]
      : []),
  ],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
      '@assets': path.resolve(
        import.meta.dirname,
        '..',
        '..',
        'attached_assets',
      ),
    },
    dedupe: ['react', 'react-dom'],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, 'dist/public'),
    emptyOutDir: true,
  },
  server: {
    port,
    strictPort: true,
    host: '0.0.0.0',
    allowedHosts: true,
    fs: {
      strict: true,
    },
  },
  preview: {
    port,
    host: '0.0.0.0',
    allowedHosts: true,
  },
  define: definedEnv,
  };
});
