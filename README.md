# Sofia Immobilier

SaaS pour agences immobilières de Bamako (Mali). Monorepo pnpm : front React/Vite, API Express, Supabase.

## Démarrage
```bash
pnpm install
cd artifacts/sofia-immobilier
cp .env.example .env   # puis remplir les valeurs
PORT=3000 BASE_PATH=/ pnpm run dev
```

## Build
```bash
PORT=3000 BASE_PATH=/ pnpm --filter @workspace/sofia-immobilier run build
# résultat : artifacts/sofia-immobilier/dist/public
```

## Variables d'environnement (front)
- `VITE_SOFIA_PUBLIC_SUPABASE_URL`
- `VITE_SOFIA_PUBLIC_SUPABASE_KEY` (clé publique uniquement, jamais de clé service_role)
