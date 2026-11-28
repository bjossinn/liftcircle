/**
 * Short, factual summary of how account data is handled — shown when creating an account.
 * Every sentence describes implemented behaviour; keep it that way (no compliance claims).
 */
import { Link } from 'react-router';
import { useT } from '@/i18n';

export function PrivacySummary() {
  const { t } = useT();
  return (
    <details className="mt-5 rounded-xl border border-line bg-surface px-4 py-1 text-sm" aria-label={t('auth.how_your_data_is_handled')}>
      <summary className="min-h-11 flex items-center cursor-pointer font-medium">{t('auth.how_your_data_is_handled')}</summary>
      <ul className="list-disc pl-4 pb-3 space-y-1.5 text-muted">
        <li>{t('auth.your_email_is_used_for_signing')}</li>
        <li>{t('auth.workouts_programs_measurements_nutrition_and_setti')}</li>
        <li>{t('auth.other_members_can_only_see_your')}</li>
        <li>{t('auth.age_weight_measurements_injuries_and_food')}</li>
        <li>
          {t('auth.you_can_download_a_backup_or')}{' '}
          <Link to="/settings/data" className="text-accent underline">
            {t('auth.settings_your_data')}
          </Link>
          .
        </li>
      </ul>
    </details>
  );
}
