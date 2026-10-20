/**
 * Compression et redimensionnement d'images avant envoi vers Supabase Storage.
 * Formats acceptés : JPG, PNG, WebP. Sortie : WebP si transparence, sinon JPG.
 */

const ACCEPTED_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp']);
const MAX_DIMENSION = 1600;
const JPEG_QUALITY = 0.85;

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
 * Compresse et redimensionne une image (max 1600 px) en préservant le ratio.
 * Retourne un fichier optimisé, ou l'original s'il est déjà léger et valide.
 */
export async function compressImage(file: File): Promise<File> {
  if (!isSupportedImageType(file.type)) {
    throw new Error('Formats acceptés : JPG, PNG ou WebP uniquement.');
  }

  try {
    const image = await loadImage(file);
    const ratio = Math.min(1, MAX_DIMENSION / Math.max(image.naturalWidth, image.naturalHeight));
    const shouldResize = ratio < 1;
    const alreadyOptimal = !shouldResize && file.size <= 500 * 1024;

    if (alreadyOptimal) return file;

    const width = Math.max(1, Math.round(image.naturalWidth * ratio));
    const height = Math.max(1, Math.round(image.naturalHeight * ratio));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) return file;
    context.drawImage(image, 0, 0, width, height);

    const hasTransparency = file.type === 'image/png' || file.type === 'image/webp';
    const outputType = hasTransparency ? 'image/webp' : 'image/jpeg';
    const blob = await canvasToBlob(canvas, outputType, JPEG_QUALITY);
    if (!blob || blob.size >= file.size) {
      // L'original est déjà plus léger : on le garde tel quel.
      if (file.size <= 10 * 1024 * 1024) return file;
      throw new Error(`L’image « ${file.name} » est trop lourde (10 Mo maximum).`);
    }

    const extension = outputType === 'image/webp' ? 'webp' : 'jpg';
    const baseName = file.name.replace(/\.[^.]+$/, '');
    return new File([blob], `${baseName}.${extension}`, { type: outputType, lastModified: Date.now() });
  } catch (error) {
    if (error instanceof Error && error.message.includes('10 Mo')) throw error;
    // Image illisible : on tente l'envoi tel quel (validation Storage fera foi).
    return file;
  }
}

export async function compressImages(files: File[]): Promise<File[]> {
  const compressed: File[] = [];
  for (const file of files) compressed.push(await compressImage(file));
  return compressed;
}
