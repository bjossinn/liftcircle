/**
 * /coach — the Coach tab. Opens the training assistant (AI coach) directly. People with human coaching (a coach now,
 * a pending request or past coaching, coaches and applicants, admins, or everyone — guests too — when the coach
 * marketplace is on) also get a switcher to the Coaching hub (/coaching): My coach, messages, the coach workspace and
 * admin. If that can't be checked yet, the Coaching entry stays with a Retry button.
 */
import { EmbeddedAiChat } from './AiChatPage';
import { CoachSwitcher, useHumanCoaching } from './coachChannels';

export default function CoachTabPage() {
  const human = useHumanCoaching();
  return <EmbeddedAiChat switcher={human.show ? <CoachSwitcher current="ai" unread={human.unread} onRetry={human.uncertain ? human.retry : undefined} /> : undefined} />;
}
