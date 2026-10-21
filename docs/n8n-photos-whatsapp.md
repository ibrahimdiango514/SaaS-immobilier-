# Sofia (n8n) — envoyer une photo de bien par WhatsApp

Guide court pour l'agent Sofia. Tout passe par **une seule fonction SQL** :
`public.property_photos_for_agent(agency_id, property_id)`.

## 1. Appel depuis n8n

Node **Postgres** (ou **HTTP Request** vers l'API REST de Supabase).

```sql
SELECT *
  FROM public.property_photos_for_agent(
    '{{ $json.agency_id }}',
    '{{ $json.property_id }}'
  );
```

Retour, **couverture d'abord** :

| colonne | usage |
|---|---|
| `is_cover` | `true` sur la photo de couverture |
| `public_url` | lien HTTPS à envoyer sur WhatsApp |
| `mime_type` | `image/jpeg`, `image/png`, `image/webp` |
| `sort_order` | ordre de la galerie |
| `reference`, `title` | libellé du bien |

**Règles de sécurité déjà appliquées dans la fonction** (ne pas les réimplémenter) :

- `EXECUTE` accordé à **`service_role` uniquement** ; `anon` et `authenticated` sont révoqués explicitement.
- Ne renvoie **rien** si `agence_active(agency_id)` est faux (agence suspendue).
- Vérifie que le bien appartient bien à `agency_id` : un `agency_id` forgé ne donne pas accès aux photos d'une autre agence.
- Écarte les lignes sans `public_url`.

Gardez quand même le nœud de contrôle `agence_active()` en tête de flow : c'est une
défense en profondeur, pas un doublon.

## 2. Envoi par WhatsApp

Le `public_url` est un lien **public et permanent** (pas un lien signé qui expire) :

```
https://xbuuhfwobrafcbgtdgjx.supabase.co/storage/v1/object/public/property-images/properties/A001/A001_01_Salon.png
```

Node **WhatsApp** (ou HTTP vers votre fournisseur) :

- `to` : numéro du client au format international
- `type` : `image`
- `image.link` : la valeur de `public_url`

Un lien direct suffit : pas de téléchargement ni de réhébergement côté n8n.
Formats acceptés et poids < 5 Mo sont garantis à l'upload (compression à 1600 px).

## 3. Vérifications rapides

```sql
-- Une agence active renvoie ses photos
SELECT count(*) FROM public.property_photos_for_agent(
  '1f60a097-774a-4404-9a20-e8aa28ff1331',
  'f7956cea-0526-456d-bf68-3d0d7c0898f4'
);

-- Une agence suspendue ne renvoie rien
SELECT count(*) FROM public.property_photos_for_agent(
  'b3a81e91-9793-4835-911b-31b31b0052c1',
  '00000000-0000-0000-0000-000000000000'
);
```

## 4. Séparation des buckets

| bucket | visibilité | contenu |
|---|---|---|
| `property-images` | **public** | photos de biens uniquement |
| `agency-assets` | public | logos d'agence |
| `payment-proofs` | **privé** | justificatifs de paiement |

Les contrats et pièces d'identité devront aller dans un bucket **privé** dédié :
jamais dans `property-images`.
