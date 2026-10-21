// =============================================================================
// BLOC 4 — Carte « Logo de l'agence » des Paramètres.
// =============================================================================
// Aperçu, remplacement et suppression. PNG / JPG / WebP, 2 Mo maximum,
// redimensionné à 512 px avant envoi (lib/agency-logo.ts).
// Lecture seule pour un agent : la RLS `agencies_update_admin` refuse déjà
// l'écriture, cette carte se contente de ne pas la proposer.
// =============================================================================
import { useRef, useState } from 'react';
import { ImageIcon, LockKeyhole, Trash2, Upload } from 'lucide-react';
import { AgencyLogo } from '@/lib/workspace-ui';
import { getSupabaseErrorMessage } from '@/lib/supabase';
import {
  MAX_LOGO_SIZE, SUPPORTED_LOGO_TYPES, useDeleteAgencyLogo, useUploadAgencyLogo,
  validateLogoFile,
} from '@/lib/agency-logo';
import { formatBytes } from '@/lib/image-tools';

export function AgencyLogoCard({
  agencyId,
  agencyName,
  logoUrl,
  canManage,
}: {
  agencyId?: string;
  agencyName?: string | null;
  logoUrl?: string | null;
  canManage: boolean;
}) {
  const upload = useUploadAgencyLogo(agencyId);
  const remove = useDeleteAgencyLogo(agencyId);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [message, setMessage] = useState('');
  const [isError, setIsError] = useState(false);

  const busy = upload.isPending || remove.isPending;

  const pick = (file: File | undefined | null) => {
    if (!file) return;
    setMessage('');
    setIsError(false);
    const invalid = validateLogoFile(file);
    if (invalid) {
      setIsError(true);
      setMessage(invalid);
      return;
    }
    upload.mutate(file, {
      onSuccess: () => {
        setIsError(false);
        setMessage('Logo mis à jour. Il s’affiche dans la barre latérale et l’en-tête.');
      },
      onError: (error) => {
        setIsError(true);
        setMessage(getSupabaseErrorMessage(error, 'mettre à jour le logo'));
      },
    });
  };

  const drop = () => {
    if (!logoUrl) return;
    if (!window.confirm('Supprimer le logo de l’agence ? Le fichier sera retiré du stockage.')) return;
    setMessage('');
    setIsError(false);
    remove.mutate(logoUrl, {
      onSuccess: () => {
        setIsError(false);
        setMessage('Logo supprimé.');
      },
      onError: (error) => {
        setIsError(true);
        setMessage(getSupabaseErrorMessage(error, 'supprimer le logo'));
      },
    });
  };

  const accept = Array.from(SUPPORTED_LOGO_TYPES).join(',');

  return (
    <section className="panel settings-panel" data-testid="panel-agency-logo">
      <div className="settings-heading">
        <div className="settings-icon"><ImageIcon size={17} /></div>
        <div>
          <h2>Logo de l’agence</h2>
          <p>Affiché dans la barre latérale, l’en-tête et la fiche de l’agence.</p>
        </div>
      </div>

      {!canManage && (
        <div className="permission-note" role="status" data-testid="status-logo-readonly">
          <LockKeyhole size={15} />
          <span>Seuls le propriétaire et les administrateurs peuvent modifier le logo.</span>
        </div>
      )}

      <div className="logo-editor">
        <div className="logo-preview" data-testid="display-logo-preview">
          <AgencyLogo logoUrl={logoUrl} name={agencyName} size={92} testId="image-agency-logo" />
        </div>
        <div className="logo-actions">
          <input
            ref={inputRef}
            type="file"
            accept={accept}
            className="sr-only"
            disabled={!canManage || busy}
            onChange={(event) => { pick(event.target.files?.[0]); event.currentTarget.value = ''; }}
            data-testid="input-agency-logo"
          />
          <button
            type="button"
            className="upload-control"
            disabled={!canManage || busy}
            onClick={() => inputRef.current?.click()}
            data-testid="button-upload-logo"
          >
            <Upload size={15} />
            {upload.isPending ? 'Envoi…' : logoUrl ? 'Remplacer le logo' : 'Choisir un logo'}
          </button>
          {logoUrl && (
            <button
              type="button"
              className="button-link danger-link"
              disabled={!canManage || busy}
              onClick={drop}
              data-testid="button-delete-logo"
            >
              <Trash2 size={14} /> {remove.isPending ? 'Suppression…' : 'Supprimer le logo'}
            </button>
          )}
          <p className="logo-constraints">
            PNG, JPG ou WebP · {formatBytes(MAX_LOGO_SIZE)} maximum ·
            redimensionné automatiquement à 512 px.
          </p>
        </div>
      </div>

      {message && (
        <p
          className={isError ? 'form-error' : 'form-feedback'}
          role={isError ? 'alert' : 'status'}
          data-testid="status-logo-message"
        >
          {message}
        </p>
      )}
    </section>
  );
}
