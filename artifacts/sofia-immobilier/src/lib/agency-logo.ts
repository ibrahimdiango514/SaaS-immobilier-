// =============================================================================
// BLOC 4 — LOGO DE L'AGENCE
// =============================================================================
// Bucket `agency-assets` (public en lecture, écriture réservée aux membres
// actifs de l'agence via les politiques existantes `agency_assets_*`).
// Chemin imposé par ces politiques : `agencies/<agency_id>/<fichier>`.
//
// PNG / JPG / WebP, 2 Mo maximum, toujours redimensionné à 512 px avant envoi.
// Chaque modification est tracée dans `saas_immobilier.activity_log`.
// =============================================================================
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { getSupabaseClient, getSupabaseErrorMessage } from './supabase';
import { formatBytes } from './image-tools';

const db = () => getSupabaseClient().schema('saas_immobilier');

export const AGENCY_ASSETS_BUCKET = 'agency-assets';
export const MAX_LOGO_SIZE = 2 * 1024 * 1024;
export const LOGO_MAX_DIMENSION = 512;
export const SUPPORTED_LOGO_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

function sanitizeLogoFileName(name: string) {
  return (
    name
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'logo'
  );
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error(`Impossible de lire l’image « ${file.name} ».`)); };
    image.src = url;
  });
}

export function validateLogoFile(file: File): string | null {
  if (!SUPPORTED_LOGO_TYPES.has(file.type)) {
    return 'Format refusé : le logo doit être un PNG, JPG ou WebP.';
  }
  if (file.size > MAX_LOGO_SIZE) {
    return `Logo trop lourd (${formatBytes(file.size)}). La limite est de ${formatBytes(MAX_LOGO_SIZE)}.`;
  }
  return null;
}

/**
 * Redimensionne le logo à 512 px maximum en préservant le ratio.
 * La transparence est conservée en WebP pour les PNG/WebP, sinon sortie JPEG.
 */
export async function prepareLogo(file: File): Promise<File> {
  const invalid = validateLogoFile(file);
  if (invalid) throw new Error(invalid);

  const image = await loadImage(file);
  const ratio = Math.min(1, LOGO_MAX_DIMENSION / Math.max(image.naturalWidth, image.naturalHeight));
  const width = Math.max(1, Math.round(image.naturalWidth * ratio));
  const height = Math.max(1, Math.round(image.naturalHeight * ratio));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  // Sans contexte 2D (navigateur privé, mémoire saturée) : on envoie l'original,
  // déjà validé sous 2 Mo.
  if (!context) return file;
  context.drawImage(image, 0, 0, width, height);

  const keepsTransparency = file.type === 'image/png' || file.type === 'image/webp';
  const outputType = keepsTransparency ? 'image/webp' : 'image/jpeg';
  const extension = outputType === 'image/webp' ? 'webp' : 'jpg';
  const baseName = file.name.replace(/\.[^.]+$/, '');

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, outputType, 0.92),
  );
  if (!blob || blob.size > MAX_LOGO_SIZE) {
    // Repli : qualité plus basse avant de refuser.
    const smaller = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, outputType, 0.7));
    if (!smaller || smaller.size > MAX_LOGO_SIZE) return file;
    return new File([smaller], `${baseName}.${extension}`, { type: outputType, lastModified: Date.now() });
  }
  return new File([blob], `${baseName}.${extension}`, { type: outputType, lastModified: Date.now() });
}

/** Chemin Storage conforme aux politiques `agency_assets_*`. */
export function logoObjectPath(agencyId: string, fileName: string) {
  return `agencies/${agencyId}/${crypto.randomUUID()}-${sanitizeLogoFileName(fileName)}`;
}

async function traceAgencyAction(agencyId: string, action: string, summary: string, metadata: Record<string, unknown> = {}) {
  // Politique activity_log_insert_auth : membre actif de l'agence.
  // Un échec de journalisation ne doit jamais faire échouer l'action elle-même :
  // le trigger `activity_log_agencies` journalise de toute façon la modification.
  try {
    const { error } = await db()
      .from('activity_log')
      .insert({ agency_id: agencyId, user_id: null, action, entity_type: 'agencies', entity_id: agencyId, summary, metadata });
    if (error) console.warn('journalisation activité refusée', error.message);
  } catch {
    /* journalisation secondaire : ignorée volontairement */
  }
}

function invalidateAgency(queryClient: ReturnType<typeof useQueryClient>, agencyId?: string) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: ['sofia', 'agencies'] }),
    // Clé identique à getAgenciesQueryKey() ; dupliquée pour éviter un import
    // circulaire avec lib/data-hooks (qui consomme prepareLogo).
    queryClient.invalidateQueries({ queryKey: ['sofia', 'agencies', agencyId ? [agencyId] : 'all'] }),
    queryClient.invalidateQueries({ queryKey: ['sofia', 'platform', 'agencies'] }),
    queryClient.invalidateQueries({ queryKey: ['sofia', 'activity'] }),
  ]);
}

/** Envoie (ou remplace) le logo et met à jour `agencies.logo_url`. */
export function useUploadAgencyLogo(agencyId?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (file: File): Promise<string> => {
      if (!agencyId) throw new Error('Aucune agence active n’est sélectionnée.');
      const prepared = await prepareLogo(file);
      const storage = getSupabaseClient().storage.from(AGENCY_ASSETS_BUCKET);
      const objectPath = logoObjectPath(agencyId, prepared.name);

      const { error: uploadError } = await storage.upload(objectPath, prepared, {
        cacheControl: '3600',
        contentType: prepared.type,
        upsert: false,
      });
      if (uploadError) throw new Error(getSupabaseErrorMessage(uploadError, 'envoyer le logo'));

      const { data: urlData } = storage.getPublicUrl(objectPath);
      const logoUrl = urlData?.publicUrl ?? null;
      if (!logoUrl) throw new Error('Impossible de construire l’URL publique du logo.');

      const { error: updateError } = await db()
        .from('agencies')
        .update({ logo_url: logoUrl })
        .eq('id', agencyId);
      if (updateError) {
        // Compensation : pas de fichier orphelin dans le stockage.
        await storage.remove([objectPath]).catch(() => undefined);
        throw updateError;
      }

      await traceAgencyAction(
        agencyId,
        'updated',
        `Logo de l’agence ${file.name ? `« ${file.name} » ` : ''}mis à jour`,
        { field: 'logo_url', object_path: objectPath, bytes: prepared.size, mime: prepared.type },
      );
      return logoUrl;
    },
    onSuccess: async () => invalidateAgency(queryClient, agencyId),
  });
}

/** Supprime le logo (fichier Storage + colonne `logo_url`). */
export function useDeleteAgencyLogo(agencyId?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (currentLogoUrl: string | null): Promise<void> => {
      if (!agencyId) throw new Error('Aucune agence active n’est sélectionnée.');
      const storage = getSupabaseClient().storage.from(AGENCY_ASSETS_BUCKET);
      const objectPath = extractLogoPath(currentLogoUrl);
      if (objectPath) {
        const { error } = await storage.remove([objectPath]);
        // Un fichier déjà absent ne doit pas bloquer la remise à zéro.
        if (error && !String(error.message).toLowerCase().includes('not found')) {
          throw new Error(getSupabaseErrorMessage(error, 'supprimer le logo'));
        }
      }
      const { error: updateError } = await db()
        .from('agencies')
        .update({ logo_url: null })
        .eq('id', agencyId);
      if (updateError) throw updateError;
      await traceAgencyAction(agencyId, 'updated', 'Logo de l’agence supprimé', { field: 'logo_url' });
    },
    onSuccess: async () => invalidateAgency(queryClient, agencyId),
  });
}

/**
 * Retrouve le chemin Storage depuis l'URL publique.
 * Le bucket est public : l'URL a la forme
 * `<projet>/storage/v1/object/public/agency-assets/<chemin>`.
 */
export function extractLogoPath(logoUrl: string | null | undefined): string | null {
  if (!logoUrl) return null;
  const marker = `/object/public/${AGENCY_ASSETS_BUCKET}/`;
  const index = logoUrl.indexOf(marker);
  if (index < 0) return null;
  const path = logoUrl.slice(index + marker.length).split('?')[0];
  return path && !path.includes('..') ? decodeURIComponent(path) : null;
}
