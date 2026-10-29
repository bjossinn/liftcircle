# Requirements: human coaches, coach discovery, and AI coaching (product brief, 29 Oct 2026)

Extend the existing app (do not restart or redesign). Preserve existing accounts, data, workouts, nutrition tools,
social features, offline support and home-screen installation. Additive, versioned migrations; focused changes;
follow the existing stack. Three connected parts: an approved human-coach directory, coach/client tools, and an
optional AI coach.

## 2. Navigation, accounts, and coach applications
Coaching area with: Look for a coach · My coach and coaching messages · AI coach · Coach dashboard (applicants and
approved coaches) · Coach administration (authorized app admins). One login/account with additional permissions; a
coach still uses their personal fitness account and can switch into the coach area.
"Become a coach" → application → admin review. Collect name, profile photo, bio, experience, specialties, languages,
city/region/country, service areas, in-person/online availability, accepting new clients, optional qualifications or
supporting documents. States: Draft, Submitted, Changes requested, Approved, Rejected. Applicants save drafts, see
status, read review feedback, resubmit when appropriate. Only approved, non-suspended coaches manage active clients.
Directory visibility additionally requires the coach to publish the listing. Pending applicants can prepare a profile
but cannot access clients or appear in search. Qualification documents private to applicant + authorized reviewers.
"Approved coach" = platform approval; no stronger verification claims unless verification actually occurred.
Listing visibility and accepting-new-clients are separate from approval; an approved coach can pause discovery or stop
accepting new clients while supporting existing clients.

## 3. Admin review and approval
Application queue, details, secure document review; approve, request changes, reject with reason, suspend, reinstate.
Record who/when/reason. Notify applicant in-app. Reviewed qualification claims that change return for review before
being published. Users/coaches can't self-grant admin or change approval fields. Document secure first-admin
provisioning. Server checks against current status; suspension removes the listing and stops coach access/actions
even with an open session; preserve client workouts and accepted programs; explain the change to affected clients.
Admin permissions scoped to applications, moderation, necessary account operations — not general browsing of client
health records.

## 4. "Look for a coach" directory and local search
Coach cards + detail pages from real approved profiles. Search own area or another location: city/town or region +
country; optional "Use my location" requesting permission only when tapped; manual search works if refused.
Filters: in-person/online/both, specialties and goals, language, accepting new clients, radius when genuine coordinates
exist. Match local searches to coach-declared service locations/areas. Rounded distance only when calculable. Use a
supported geocoding integration or maintained dataset; never invent coordinates/distances. Without a provider:
useful city/region search + documentation to enable distance. Distinguish remote from nearby coaches. Map optional.
Cards: name/photo, specialties, location/service area, format, language, availability, profile link. Profile:
experience, approved claims, "Request coaching". Publish only coach-chosen business/service locations; never a client's
precise location or a coach's home address. No fake ratings, testimonials or clients.

## 5. Client requests, consent, relationship management
Coaching relationships separate from friendships. "Request coaching" → short intake from existing goals/preferences +
intro message + choose what to share. States: Requested, Active, Declined, Cancelled, Ended. Coach accepts/declines;
cancellation while pending. (Coach invitations would need client acceptance.) Pending: coach sees only intake + initial
message. Active access needs approved coach AND client's explicit permission. Separate sharing controls: training
history/adherence, measurements, nutrition records, selected photos/check-ins; explain which categories a service
needs. Friendship never grants coaching access. Clients review/revoke permissions and end coaching; revocation,
termination, blocking and suspension stop subsequent unauthorized queries and writes, including queued offline ops.
One primary human coach per client with explicit switching; coaches have many clients; coaches can't assign themselves
users. Ending preserves client-owned workouts and accepted program copies; explain chat-history retention.

## 6. Coach dashboard and client programs
Dashboard: active clients & pending requests, unread conversations, recent completion/adherence from permitted
records, check-ins/program reviews needing attention, quick access to each client's program. Client detail: intake,
goals, current program, authorized recent activity, feedback, optional check-ins — permissions respected per panel.
Reuse the existing program editor + exercise catalog. Coach templates; duplicate for a client; customize order, sets,
reps, rest, effort, substitutions, schedule, progression instructions. Draft → send proposal → client previews and
accepts → appears in existing Train/Today and logger. Track author, client, version, effective date, active-plan
ownership; revisions show changes and need acceptance. Updates affect future sessions only; coaches review/feedback on
logs but can't alter recorded results. Missed sessions/schedule changes → reschedule + revised proposal. One clearly
identified active plan; self, coach and AI plans can't overwrite one another.

## 7. Coach/client messaging
Persistent private 1:1 messaging in the Coaching area: history, timestamps, unread indicators, in-app notifications,
reliable ordering, loading/retry, sent/pending/failed status; realtime desirable, polling acceptable. Text first;
optional photos via the secure media pipeline with conversation-specific permissions. Server authorizes every read and
send. Pending requests contain only the intake message; chat starts after acceptance. Ended conversations read-only
for participants retaining access under the retention policy. Persist before showing as sent; retries never duplicate
messages or notifications; offline messages labeled drafts/queued and recheck permission before sending.
Notifications never leak content to unrelated users. Block/report controls; existing moderation model.

## 8. AI coach enrollment and experience
"Start with an AI coach" beside "Look for a coach"; short setup; activates after the user agrees; no admin approval.
Reuse goals, experience, days, equipment, exclusions, preferences; ask only missing info; allow corrections. Explain data
categories sent to the AI provider; enable/pause/disable and change data access. Label AI messages and AI
recommendations. Provide: persistent chat; suggested questions and on-demand progress/check-in review; explanations
grounded in permitted records; draft programs and adjustments; help with missed sessions, schedule changes,
substitutions, progression; optional protein guidance and meal ideas using existing nutrition tools; pending
recommendations list. Real server-side provider integration (Anthropic Messages API), config on the server, secrets out
of the browser; authenticated requests, per-user limits, bounded context, timeouts, retry controls, cost/usage tracking;
document API setup and charges (a Claude chat subscription does not provide API access). Missing credentials/outage →
truthful unavailable state; tracker + deterministic generator keep working; AI chat needs connectivity; preserve
unsent drafts offline.

## 9. AI context, proposed actions, human-coach coordination
Server builds context from the authenticated user's currently permitted records (goals, active program, recent
workouts, equipment, preferences, authorized nutrition). AI conversations private by default; human coaches see
selected AI messages/summaries only when the client deliberately shares them; coach conversations and private coach
notes never enter AI context automatically. User can inspect/correct any persistent AI profile/summary. Revoking access
affects future lookups and cached summaries/context; explain actual retention without claiming unimplemented
provider-side deletion. Use existing validated calculations (protein, calories, progression, units). Distinguish
recorded facts from suggestions; acknowledge missing info; follow exercise/nutrition limits; no diagnosis, no invented
achievements/workouts/clinical certainty. Proposed program changes are structured drafts validated (exercise IDs,
equipment, exclusions, sets/reps, schedule, schema) before being offered; preview + explanation; applying is deliberate
and creates a new version; recheck active version (stale proposals can't overwrite newer plans). If a human coach
manages the active program, AI explains/suggests but changes go through coach review + client acceptance, or the client
explicitly switches to a self/AI plan. Messages, notes and uploads are untrusted input: they can't change permissions,
expose other users' records, or authorize actions. AI gets narrowly scoped server operations only.

## 10. Data, integration, verification
Only needed entities; reuse program/version/media/notification tables where appropriate; additive; ownership
protected; RLS consistent with the existing backend; owner-only defaults plus narrow access for an active, approved
coach with current client permission — enforced on the backend. Tests: (1) submit/resubmit; pending/rejected absent and
no client access (2) approval enables eligible listings; suspension revokes access despite a session (3) location
search, remote filters, denied geolocation → truthful usable results (4) pending → intake only; active → consented data
only (5) other coach / social friend / unrelated user can't query client records, messages or private documents
(6) revocation, termination, blocking affect direct API requests and queued writes (7) coach creates, assigns, revises a
program through the existing workout flow without changing historical results (8) messaging persists; retries don't
duplicate (9) AI uses the correct user's permitted context; tampered IDs/malicious notes can't access other data
(10) AI proposals stay drafts until approved, reject stale versions, can't silently replace a human-coach program
(11) missing AI credentials, rate limits, outages leave existing features usable (12) existing logging, offline
recovery, social, nutrition, PWA still work. Distinguish mocked integration tests from live-provider verification.
Update setup docs and BUILD_STATUS.md; migration instructions, first-admin provisioning, location-provider setup,
AI environment configuration.
