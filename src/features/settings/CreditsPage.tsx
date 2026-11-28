import { useNavigate } from 'react-router';
import { ChevronLeft, ExternalLink } from 'lucide-react';
import { Card, IconButton, Page } from '@/components/ui';
import { CREDITS_ILLUSTRATIONS_ID, EXERCISE_MEDIA_CREDIT, EXERCISE_MEDIA_MAPPING } from '@/data/exerciseMedia';
import { useT } from '@/i18n';

/**
 * Credits & licences: the full attribution for third-party media (docs/THIRD_PARTY_MEDIA.md is the record). The
 * exercise illustrations' CC BY-SA 4.0 credit requires the source, creator, licence and a notice of our changes; the
 * short credit next to each illustration and the list/Settings links all point here.
 */
export default function CreditsPage() {
  const { t, tp } = useT();
  const nav = useNavigate();
  const c = EXERCISE_MEDIA_CREDIT;
  const count = Object.keys(EXERCISE_MEDIA_MAPPING).length;
  const ext = (href: string, label: string) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-medium text-accent underline break-all">
      {label}
      <ExternalLink className="size-3.5 shrink-0" aria-hidden />
    </a>
  );
  return (
    <Page
      title={t('credits.title')}
      back={
        <IconButton label={t('nav.goBack')} onClick={() => nav(-1)}>
          <ChevronLeft className="size-6" />
        </IconButton>
      }
    >
      <Card as="section" className="p-4 text-[15px] leading-relaxed" aria-labelledby={CREDITS_ILLUSTRATIONS_ID} data-testid="credits-illustrations">
        <h2 id={CREDITS_ILLUSTRATIONS_ID} className="text-lg font-semibold">
          {t('credits.illustrations.title')}
        </h2>
        <p className="mt-2">{t('credits.illustrations.by', { author: c.author, site: c.site, creator: c.creator })}</p>
        <p className="mt-1 text-sm text-muted">{tp('credits.illustrations.used', count)}</p>
        <dl className="mt-3 grid gap-3 text-sm">
          <div>
            <dt className="text-xs text-muted">{t('credits.source')}</dt>
            <dd className="mt-0.5">{ext(c.sourceUrl, c.sourceUrl.replace(/^https:\/\//, ''))}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">{t('credits.license')}</dt>
            <dd className="mt-0.5">{ext(c.licenseUrl, `${c.license} (Creative Commons Attribution-ShareAlike 4.0 International)`)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">{t('credits.changes')}</dt>
            <dd className="mt-0.5">{t('credits.illustrations.changes')}</dd>
          </div>
        </dl>
        <p className="mt-3 text-sm text-muted">{t('credits.illustrations.others')}</p>
      </Card>
    </Page>
  );
}
