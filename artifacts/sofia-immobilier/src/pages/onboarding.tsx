import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'wouter';
import { ArrowLeft, ArrowRight, Building2, CheckCircle2, ImagePlus, MapPin, Phone, ShieldCheck, X } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { useAuth } from '@/lib/auth-context';
// BLOC 4 : regles logo partagees (PNG/JPG/WebP, 2 Mo).
import { validateLogoFile } from '@/lib/agency-logo';
import { useAgency } from '@/lib/agency-context';
import { useCreateAgency } from '@/lib/data-hooks';
import { getSupabaseErrorMessage } from '@/lib/supabase';
import { BrandMark } from '@/lib/workspace-ui';

const onboardingSchema = z.object({
  name: z.string().trim().min(2, 'Le nom de l’agence est obligatoire (2 caractères minimum)'),
  legal_name: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().email('Adresse e-mail invalide').or(z.literal('')).optional(),
  address: z.string().optional(),
  city: z.string().trim().min(1, 'La ville est obligatoire'),
  description: z.string().optional(),
});
type OnboardingValues = z.infer<typeof onboardingSchema>;

const STEPS = [
  { key: 'identity', title: 'Votre agence', subtitle: 'Nom et raison sociale', icon: Building2 },
  { key: 'contact', title: 'Coordonnées', subtitle: 'Téléphone, adresse, ville', icon: Phone },
  { key: 'branding', title: 'Présentation', subtitle: 'Logo et description', icon: ImagePlus },
  { key: 'review', title: 'Confirmation', subtitle: 'Vérifiez puis créez', icon: CheckCircle2 },
];

export default function OnboardingPage() {
  const { user, loading } = useAuth();
  const { memberships, loading: agencyLoading } = useAgency();
  const createAgency = useCreateAgency();
  const [, navigate] = useLocation();
  const [step, setStep] = useState(0);
  const [logo, setLogo] = useState<File | null>(null);
  const [logoPreview, setLogoPreview] = useState<string | null>(null);
  const [formError, setFormError] = useState('');

  const form = useForm<OnboardingValues>({
    resolver: zodResolver(onboardingSchema),
    defaultValues: { name: '', legal_name: '', phone: '', email: '', address: '', city: 'Bamako', description: '' },
  });

  useEffect(() => {
    if (loading) return;
    if (!user) {
      navigate('/login');
      return;
    }
    if (!agencyLoading && memberships.length > 0) {
      navigate('/dashboard');
    }
  }, [loading, user, agencyLoading, memberships, navigate]);

  useEffect(() => () => {
    if (logoPreview) URL.revokeObjectURL(logoPreview);
  }, [logoPreview]);

  const progress = useMemo(() => `${((step + 1) / STEPS.length) * 100}%`, [step]);

  const goNext = async () => {
    setFormError('');
    const fieldsByStep: Array<Array<keyof OnboardingValues>> = [
      ['name'],
      ['city'],
      [],
      [],
    ];
    const fields = fieldsByStep[step];
    const valid = fields.length ? await form.trigger(fields) : true;
    if (!valid) return;
    setStep((s) => Math.min(s + 1, STEPS.length - 1));
  };

  const goBack = () => {
    setFormError('');
    setStep((s) => Math.max(s - 1, 0));
  };

  const submit = async (values: OnboardingValues) => {
    setFormError('');
    try {
      await createAgency.mutateAsync({
        name: values.name,
        legal_name: values.legal_name || null,
        phone: values.phone || null,
        email: values.email || null,
        address: values.address || null,
        city: values.city,
        description: values.description || null,
        logo,
      });
      navigate('/dashboard');
    } catch (error) {
      const message = getSupabaseErrorMessage(error, 'créer l’agence');
      setFormError(
        message.toLowerCase().includes('duplicate') || message.toLowerCase().includes('slug')
          ? 'Une agence portant ce nom existe déjà. Choisissez un autre nom.'
          : message,
      );
      setStep(1);
    }
  };

  if (loading) {
    return (
      <div className="auth-loading">
        <div className="brand-lockup"><BrandMark /><div className="brand-name">sofia immobilier</div></div>
        <p className="auth-loading-caption">Chargement de votre espace…</p>
      </div>
    );
  }

  const values = form.getValues();

  return (
    <div className="onboarding-page">
      <header className="onboarding-header">
        <div className="brand-lockup"><BrandMark /><div><div className="brand-name">sofia immobilier</div><div className="brand-caption">Création de votre agence</div></div></div>
        <button type="button" className="text-action" onClick={() => navigate('/dashboard')} data-testid="button-skip-onboarding">Plus tard</button>
      </header>

      <main className="onboarding-main">
        <section className="onboarding-progress" aria-label="Progression">
          <div className="onboarding-progress-track"><span style={{ width: progress }} /></div>
          <ol className="onboarding-steps">
            {STEPS.map((item, index) => (
              <li key={item.key} className={index === step ? 'is-current' : index < step ? 'is-done' : ''}>
                <span className="onboarding-step-icon">{index < step ? <CheckCircle2 size={15} /> : <item.icon size={15} />}</span>
                <div><strong>{item.title}</strong><small>{item.subtitle}</small></div>
              </li>
            ))}
          </ol>
        </section>

        <section className="panel onboarding-card" data-testid="card-onboarding">
          <Form {...form}>
            <form onSubmit={form.handleSubmit(submit)} className="onboarding-form">
              {step === 0 && (
                <div className="onboarding-step">
                  <span className="form-kicker">Étape 1 sur 4</span>
                  <h1>Comment s’appelle votre agence ?</h1>
                  <p>Ce nom apparaîtra dans votre espace de travail et sur vos documents.</p>
                  <FormField control={form.control} name="name" render={({ field }) => (
                    <FormItem><FormLabel>Nom commercial de l’agence *</FormLabel><FormControl>
                      <Input {...field} placeholder="Ex. Immo Bamako Conseil" data-testid="input-onboarding-name" autoFocus />
                    </FormControl><FormMessage /></FormItem>
                  )} />
                  <FormField control={form.control} name="legal_name" render={({ field }) => (
                    <FormItem><FormLabel>Raison sociale (optionnel)</FormLabel><FormControl>
                      <Input {...field} placeholder="Ex. SARL Immo Bamako" data-testid="input-onboarding-legal-name" />
                    </FormControl><FormMessage /></FormItem>
                  )} />
                </div>
              )}

              {step === 1 && (
                <div className="onboarding-step">
                  <span className="form-kicker">Étape 2 sur 4</span>
                  <h1>Où vous joindre ?</h1>
                  <p>Ces coordonnées restent visibles uniquement par votre équipe.</p>
                  <div className="form-grid">
                    <FormField control={form.control} name="phone" render={({ field }) => (
                      <FormItem><FormLabel>Téléphone</FormLabel><FormControl>
                        <Input {...field} placeholder="+223 70 00 00 00" data-testid="input-onboarding-phone" />
                      </FormControl><FormMessage /></FormItem>
                    )} />
                    <FormField control={form.control} name="email" render={({ field }) => (
                      <FormItem><FormLabel>E-mail de l’agence</FormLabel><FormControl>
                        <Input {...field} type="email" placeholder="contact@agence.ml" data-testid="input-onboarding-email" />
                      </FormControl><FormMessage /></FormItem>
                    )} />
                  </div>
                  <FormField control={form.control} name="address" render={({ field }) => (
                    <FormItem><FormLabel>Adresse</FormLabel><FormControl>
                      <Input {...field} placeholder="Quartier, rue, repère…" data-testid="input-onboarding-address" />
                    </FormControl><FormMessage /></FormItem>
                  )} />
                  <FormField control={form.control} name="city" render={({ field }) => (
                    <FormItem><FormLabel>Ville *</FormLabel><FormControl>
                      <Input {...field} placeholder="Bamako" data-testid="input-onboarding-city" />
                    </FormControl><FormMessage /></FormItem>
                  )} />
                </div>
              )}

              {step === 2 && (
                <div className="onboarding-step">
                  <span className="form-kicker">Étape 3 sur 4</span>
                  <h1>Présentez votre agence</h1>
                  <p>Logo (JPG, PNG ou WebP — 2 Mo max., redimensionné automatiquement) et description courte.</p>
                  <div className="logo-picker">
                    {logoPreview ? (
                      <div className="logo-preview">
                        <img src={logoPreview} alt="Aperçu du logo" />
                        <button type="button" className="icon-button" onClick={() => { setLogo(null); setLogoPreview(null); }} aria-label="Retirer le logo">
                          <X size={14} />
                        </button>
                      </div>
                    ) : (
                      <label className="upload-control">
                        <input
                          type="file"
                          accept="image/jpeg,image/png,image/webp"
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            if (!file) return;
                            // BLOC 4 : mêmes règles que les Paramètres.
                            const invalid = validateLogoFile(file);
                            if (invalid) {
                              setFormError(invalid);
                              e.currentTarget.value = '';
                              return;
                            }
                            setFormError('');
                            setLogo(file);
                            setLogoPreview(URL.createObjectURL(file));
                          }}
                          data-testid="input-onboarding-logo"
                        />
                        <ImagePlus size={15} /> Choisir un logo
                      </label>
                    )}
                  </div>
                  <FormField control={form.control} name="description" render={({ field }) => (
                    <FormItem><FormLabel>Description de l’agence</FormLabel><FormControl>
                      <Textarea {...field} placeholder="Spécialistes de l’immobilier à Bamako depuis 2020…" data-testid="input-onboarding-description" />
                    </FormControl><FormMessage /></FormItem>
                  )} />
                </div>
              )}

              {step === 3 && (
                <div className="onboarding-step">
                  <span className="form-kicker">Étape 4 sur 4</span>
                  <h1>Prêt à créer votre espace ?</h1>
                  <p>Vérifiez les informations : elles pourront être modifiées ensuite dans les paramètres.</p>
                  <div className="review-list" data-testid="display-onboarding-review">
                    <div><span>Agence</span><strong>{values.name || '—'}</strong></div>
                    <div><span>Raison sociale</span><strong>{values.legal_name || 'Non renseignée'}</strong></div>
                    <div><span>Téléphone</span><strong>{values.phone || 'Non renseigné'}</strong></div>
                    <div><span>E-mail</span><strong>{values.email || 'Non renseigné'}</strong></div>
                    <div><span>Adresse</span><strong>{[values.address, values.city].filter(Boolean).join(', ') || '—'}</strong></div>
                    <div><span>Logo</span><strong>{logo ? logo.name : 'Ajouté plus tard'}</strong></div>
                  </div>
                  <div className="notice-box">
                    <ShieldCheck size={14} />
                    <span>Votre agence sera créée avec un abonnement Starter, son espace isolé et un accès propriétaire pour votre compte.</span>
                  </div>
                </div>
              )}

              {formError && <p className="form-error" role="alert" data-testid="status-onboarding-error">{formError}</p>}

              <div className="onboarding-actions">
                {step > 0 ? (
                  <Button type="button" variant="outline" onClick={goBack} disabled={createAgency.isPending} data-testid="button-onboarding-back">
                    <ArrowLeft size={15} /> Retour
                  </Button>
                ) : (
                  <span />
                )}
                {step < STEPS.length - 1 ? (
                  <Button type="button" onClick={() => void goNext()} data-testid="button-onboarding-next">
                    Continuer <ArrowRight size={15} />
                  </Button>
                ) : (
                  <Button type="submit" disabled={createAgency.isPending} data-testid="button-onboarding-submit">
                    {createAgency.isPending ? 'Création de l’agence…' : 'Créer mon agence'} <CheckCircle2 size={15} />
                  </Button>
                )}
              </div>
            </form>
          </Form>
        </section>

        <p className="onboarding-foot">
          <MapPin size={13} /> Vos données sont hébergées sur Supabase et isolées par agence grâce aux politiques RLS.
        </p>
      </main>
    </div>
  );
}
