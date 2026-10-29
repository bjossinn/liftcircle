/**
 * Short, factual summary of how account data is handled — shown when creating an account.
 * Every sentence describes implemented behaviour; keep it that way (no compliance claims).
 */
import { Link } from 'react-router';

export function PrivacySummary() {
  return (
    <details className="mt-5 rounded-xl border border-line bg-surface px-4 py-1 text-sm" aria-label="How your data is handled">
      <summary className="min-h-11 flex items-center cursor-pointer font-medium">How your data is handled</summary>
      <ul className="list-disc pl-4 pb-3 space-y-1.5 text-muted">
        <li>Your email is used for signing in. It isn’t shown on your profile or used for friend search.</li>
        <li>Workouts, programs, measurements, nutrition and settings are saved on this device and backed up to your account so you can use them on other devices.</li>
        <li>Other members can only see your username, display name, avatar, bio and interests, and the posts you choose to share with them.</li>
        <li>
          Age, weight, measurements, injuries and food logs are never shown to other members. You can choose to share selected categories with a coach you approve, or with the
          AI coach after you agree to it — and change or stop that at any time.
        </li>
        <li>
          You can download a backup or delete your account at any time from{' '}
          <Link to="/settings/data" className="text-accent underline">
            Settings → Your data
          </Link>
          .
        </li>
      </ul>
    </details>
  );
}
