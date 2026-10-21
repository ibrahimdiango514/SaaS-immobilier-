/**
 * Compression et redimensionnement d'images avant envoi vers Supabase Storage.
 * Formats acceptés : JPG, PNG, WebP. Sortie : WebP si transparence, sinon JPG.
 *
 * LOT B (point A) — cible de poids : 5 Mo.
 * La compression procède par étapes : dimensions plafonnées à 1600 px, puis
 * qualité JPEG/WebP réduite palier par palier jusqu'à passer sous la cible.
 * Le fichier n'est refusé que si aucun palier n'y parvient.
 *
 * Ne concerne que les NOUVEAUX uploads : les photos déjà en base et leurs
 * public_url ne sont jamais retouchées.
 */

const ACCEPTED_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp']);
const MAX_DIMENSION = 1600;

/** Cible imposée pour que le lien reste exploitable sur WhatsApp. */
const MAX_TARGET_SIZE = 5 * 1024 * 1024;

/** Paliers de qualité essayés dans l'ordre, du plus fidèle au plus agressif. */
const QUALITY_STEPS = [0.85, 0.75, 0.65, 0.55, 0.45, 0.35, 0.25];

export function isSupportedImageType(type: string): boolean {
  return ACCEPTED_TYPES.has(type);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} Ko`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`Impossible de lire l’image « ${file.name} ».`));
    };
    image.src = url;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/**
 * Compresse et redimensionne une image (max 1600 px) en préservant le ratio,
 * puis réduit la qualité par paliers jusqu'à passer sous 5 Mo.
 * Retourne un fichier optimisé, ou l'original s'il est déjà sous la cible.
 */
export async function compressImage(file: File): Promise<File> {
  if (!isSupportedImageType(file.type)) {
    throw new Error('Formats acceptés : JPG, PNG ou WebP uniquement.');
  }

  // Déjà sous la cible : aucun retraitement, on évite une perte de qualité inutile.
  if (file.size <= MAX_TARGET_SIZE) return file;

  try {
    const image = await loadImage(file);
    const ratio = Math.min(1, MAX_DIMENSION / Math.max(image.naturalWidth, image.naturalHeight));
    const width = Math.max(1, Math.round(image.naturalWidth * ratio));
    const height = Math.max(1, Math.round(image.naturalHeight * ratio));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    // Sans contexte 2D on ne peut pas recompresser : l'original dépasse la cible.
    if (!context) {
      throw new Error(
        `L’image « ${file.name} » dépasse 5 Mo et n’a pas pu être compressée (${formatBytes(file.size)}).`,
      );
    }
    context.drawImage(image, 0, 0, width, height);

    const hasTransparency = file.type === 'image/png' || file.type === 'image/webp';
    const outputType = hasTransparency ? 'image/webp' : 'image/jpeg';
    const extension = outputType === 'image/webp' ? 'webp' : 'jpg';
    const baseName = file.name.replace(/\.[^.]+$/, '');

    // Descente par paliers : on s'arrête au premier résultat sous la cible.
    let best: Blob | null = null;
    for (const quality of QUALITY_STEPS) {
      const blob = await canvasToBlob(canvas, outputType, quality);
      if (!blob) continue;
      if (!best || blob.size < best.size) best = blob;
      if (blob.size <= MAX_TARGET_SIZE) {
        return new File([blob], `${baseName}.${extension}`, {
          type: outputType,
          lastModified: Date.now(),
        });
      }
    }

    // Aucun palier n'a suffi : refus explicite plutôt qu'un envoi hors limite.
    throw new Error(
      `L’image « ${file.name} » reste trop lourde après compression ` +
        `(${formatBytes(best?.size ?? file.size)}). Utilisez un fichier plus léger.`,
    );
  } catch (error) {
    // On laisse passer nos propres refus, ainsi que les images illisibles dont
    // la taille est déjà connue comme supérieure à la cible.
    if (error instanceof Error && error.message.includes(file.name)) throw error;
    throw new Error(
      `L’image « ${file.name} » dépasse 5 Mo et n’a pas pu être compressée.`,
    );
  }
}

export async function compressImages(files: File[]): Promise<File[]> {
  const compressed: File[] = [];
  for (const file of files) compressed.push(await compressImage(file));
  return compressed;
}
