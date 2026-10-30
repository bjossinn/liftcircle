/**
 * Coaching + AI coach contract shared by the client and the Supabase implementation.
 * Implementations: src/backend/coaching.ts (CoachingApi), src/backend/ai.ts (AiApi).
 * Server: supabase/migrations/2026102900000{1..}_*.sql, supabase/functions/{ai-coach,geocode,finalize-coach-media}.
 * Spec of tables/RPCs/states: docs/COACHING_INTERFACES.md.
 */
import type { CoachStyle, ID, ISODate, ProgramVersion } from '@/domain/types';

/* ================================================================ coaches */
export type ApplicationStatus = 'draft' | 'submitted' | 'changes_requested' | 'approved' | 'rejected';
export type CoachFormat = 'in_person' | 'online';

export interface ServiceArea {
  id: ID;
  kind: 'city' | 'region' | 'country';
  city?: string | null;
  region?: string | null;
  country: string; // ISO 3166-1 alpha-2, upper case
  /** Only present when obtained from the configured geocoder (never typed in or invented). */
  lat?: number | null;
  lng?: number | null;
  radiusKm?: number | null; // in-person travel radius around lat/lng
  label?: string | null; // geocoder display label
}

export interface Qualification {
  id: ID;
  title: string;
  issuer?: string | null;
  year?: number | null;
  /** Private storage path in bucket 'coach-docs' (applicant + admins only). */
  documentPath?: string | null;
  documentName?: string | null;
  reviewStatus: 'pending' | 'approved' | 'rejected';
  reviewNote?: string | null;
}

/** The applicant's own full view (application + profile). */
export interface CoachProfile {
  userId: ID;
  displayName: string;
  photoPath?: string | null;
  photoUrl?: string | null; // signed
  bio: string;
  experienceYears?: number | null;
  experience: string;
  specialties: string[];
  goals: string[];
  languages: string[]; // ISO 639-1 codes, e.g. 'en', 'is'
  city?: string | null;
  region?: string | null;
  country?: string | null;
  formats: CoachFormat[];
  acceptingClients: boolean;
  listed: boolean; // coach chose to publish the listing (visible only if approved & not suspended)
  status: ApplicationStatus;
  suspended: boolean;
  suspendedReason?: string | null;
  submittedAt?: string | null;
  reviewedAt?: string | null;
  latestFeedback?: string | null; // most recent reviewer reason/feedback addressed to applicant
  serviceAreas: ServiceArea[];
  qualifications: Qualification[];
  updatedAt?: string;
}

export type CoachProfileInput = Omit<
  CoachProfile,
  'userId' | 'photoUrl' | 'status' | 'suspended' | 'suspendedReason' | 'submittedAt' | 'reviewedAt' | 'latestFeedback' | 'updatedAt' | 'qualifications' | 'serviceAreas'
> & {
  serviceAreas: Omit<ServiceArea, 'id'>[] & Partial<Pick<ServiceArea, 'id'>>[];
  qualifications: (Omit<Qualification, 'reviewStatus' | 'reviewNote'> & { id: ID })[];
};

/** What the public directory shows. Only approved, non-suspended, listed coaches. */
export interface CoachCard {
  userId: ID;
  displayName: string;
  photoUrl?: string | null;
  bio: string;
  specialties: string[];
  goals: string[];
  languages: string[];
  city?: string | null;
  region?: string | null;
  country?: string | null;
  formats: CoachFormat[];
  acceptingClients: boolean;
  serviceAreas: ServiceArea[]; // without radius precision beyond what the coach published
  /** 'local' = a declared service area matches the searched place; 'remote' = online-only match. */
  match: 'local' | 'remote';
  /** Rounded km; present ONLY when both the search point and a service area have geocoder coordinates. */
  distanceKm?: number | null;
}

export interface CoachDetail extends CoachCard {
  experienceYears?: number | null;
  experience: string;
  approvedQualifications: Pick<Qualification, 'id' | 'title' | 'issuer' | 'year'>[];
  approvedSince?: string | null;
}

export interface CoachSearch {
  /** Place typed by the user (any can be blank). */
  city?: string;
  region?: string;
  country?: string;
  /** From browser geolocation (rounded to 2 decimals client-side) or a geocoded place. Never stored. */
  lat?: number | null;
  lng?: number | null;
  radiusKm?: number | null;
  format?: 'any' | 'in_person' | 'online';
  specialty?: string;
  goal?: string;
  language?: string;
  acceptingOnly?: boolean;
  limit?: number;
  offset?: number;
}

export interface GeocodeResult {
  label: string;
  city?: string | null;
  region?: string | null;
  country: string;
  lat: number;
  lng: number;
}

/* =========================================================== relationships */
export type RelationshipStatus = 'requested' | 'active' | 'declined' | 'cancelled' | 'ended';

export interface SharingScopes {
  training: boolean; // workouts, adherence, program, goals
  measurements: boolean; // bodyweight & body measurements
  nutrition: boolean; // food logs & nutrition targets
  checkins: boolean; // check-ins incl. selected check-in photos
}

/** Snapshot the CLIENT chose to share with the request (copied, not live). */
export interface CoachingIntake {
  goal?: string;
  secondaryGoal?: string;
  experience?: string;
  daysPerWeek?: number;
  sessionMinutes?: number;
  equipment?: string[];
  limitations?: string[]; // areas only, never diagnoses
  preferredFormat?: CoachFormat;
  notes?: string;
}

export interface CoachingRelationship {
  id: ID;
  coachId: ID;
  clientId: ID;
  coach: { userId: ID; displayName: string; photoUrl?: string | null; suspended: boolean; approved: boolean };
  client: { userId: ID; displayName: string; avatarUrl?: string | null };
  status: RelationshipStatus;
  intake: CoachingIntake;
  introMessage: string;
  scopes: SharingScopes;
  requestedAt: string;
  respondedAt?: string | null;
  endedAt?: string | null;
  endedBy?: ID | null;
  endReason?: string | null;
  unread: number;
  /** true when the viewer is the coach in this relationship */
  viewerIsCoach: boolean;
}

/* ================================================================= programs */
export type ProposalStatus = 'draft' | 'sent' | 'accepted' | 'declined' | 'withdrawn' | 'superseded' | 'invalid';

/** Program content as proposed (same shape as an existing ProgramVersion minus bookkeeping). */
export type ProposedProgram = Omit<ProgramVersion, 'version' | 'createdAt'> & {
  name: string;
  progressionNotes?: string;
};

export interface ProgramProposal {
  id: ID;
  authorKind: 'coach' | 'ai';
  relationshipId?: ID | null; // coach proposals
  coachId?: ID | null;
  clientId: ID;
  status: ProposalStatus;
  /** Client program this revises (null = a new plan). Applying requires the client's current version to equal baseVersion. */
  baseProgramId?: ID | null;
  baseVersion?: number | null;
  revision: number; // 1, 2, 3… per (relationship|ai, base program)
  program: ProposedProgram;
  changeSummary: string[];
  message?: string | null;
  effectiveDate?: ISODate | null;
  /** AI only: the AI may not replace a coach-managed plan; such proposals are 'for_coach_review'. */
  target: 'apply' | 'for_coach_review';
  validationErrors?: string[];
  createdAt: string;
  sentAt?: string | null;
  respondedAt?: string | null;
  appliedProgramId?: ID | null;
  appliedVersion?: number | null;
}

/* ============================================================ messaging */
export interface CoachMessage {
  id: ID; // client-generated (idempotent)
  relationshipId: ID;
  senderId: ID;
  body: string;
  media: { id: ID; width: number; height: number; url?: string; thumbUrl?: string }[];
  /** 'sent' once persisted on the server; local-only states are 'queued' | 'sending' | 'failed'. */
  status: 'sent' | 'queued' | 'sending' | 'failed' | 'awaiting_media';
  seq?: number; // server order
  createdAt: string; // server timestamp (local time for unsent)
  sharedFromAi?: boolean;
}

export interface CoachFeedback {
  id: ID;
  relationshipId: ID;
  sessionId?: ID | null; // the client's workout the feedback refers to
  body: string;
  createdAt: string;
}

export interface CheckIn {
  id: ID;
  relationshipId: ID;
  clientId: ID;
  createdAt: string;
  answers: { energy?: number; sleep?: number; soreness?: number; stress?: number; bodyweightKg?: number | null; wins?: string; struggles?: string };
  note?: string | null;
  coachResponse?: string | null;
  reviewedAt?: string | null;
}

/** Coach-side read of a client's permitted records (each panel null when not permitted). */
export interface ClientOverview {
  relationship: CoachingRelationship;
  training: null | {
    activeProgram: { id: ID; name: string; currentVersion: number; managedBy?: string | null } | null;
    recentSessions: { id: ID; date: ISODate; name: string; status: string; durationMin?: number | null; workingSets: number }[];
    plannedLast28: number | null;
    completedLast28: number;
  };
  measurements: null | { date: ISODate; kind: string; value: number }[];
  nutrition: null | { date: ISODate; protein?: number | null; kcal?: number | null }[];
  checkins: null | CheckIn[];
}

/* ================================================================= admin */
export type ReviewAction = 'approve' | 'request_changes' | 'reject' | 'suspend' | 'reinstate' | 'approve_qualification' | 'reject_qualification';
export interface ReviewEvent {
  id: ID;
  coachId: ID;
  actorId: ID;
  actorName?: string | null;
  action: ReviewAction | 'submitted' | 'resubmitted' | 'qualifications_changed';
  reason?: string | null;
  qualificationId?: ID | null;
  fromStatus?: string | null;
  toStatus?: string | null;
  createdAt: string;
}

export interface CoachingApi {
  /* roles */
  myRoles(): Promise<{ admin: boolean; moderator: boolean }>;

  /* applicant / coach profile */
  getMyCoachProfile(): Promise<CoachProfile | null>;
  saveMyCoachProfile(input: CoachProfileInput): Promise<CoachProfile>; // allowed in any state; approved claims re-enter review when changed
  submitApplication(): Promise<CoachProfile>; // draft | changes_requested | rejected → submitted
  uploadCoachPhoto(blob: Blob): Promise<string>; // returns path
  uploadQualificationDocument(qualificationId: ID, file: Blob, filename: string): Promise<string>; // private path
  documentUrl(path: string): Promise<string>; // short-lived signed URL (applicant or admin only)
  setListing(listed: boolean, acceptingClients: boolean): Promise<void>;
  myReviewEvents(): Promise<ReviewEvent[]>;

  /* directory */
  searchCoaches(q: CoachSearch): Promise<{ items: CoachCard[]; distanceAvailable: boolean }>;
  getCoach(userId: ID): Promise<CoachDetail | null>;
  geocode(query: string): Promise<{ available: boolean; results: GeocodeResult[] }>;

  /* relationships (client side) */
  requestCoaching(input: { id: ID; coachId: ID; intake: CoachingIntake; introMessage: string; scopes: SharingScopes }): Promise<CoachingRelationship>; // idempotent on id
  cancelRequest(relationshipId: ID): Promise<void>;
  endCoaching(relationshipId: ID, reason?: string): Promise<void>; // either party
  setScopes(relationshipId: ID, scopes: SharingScopes): Promise<void>; // client only
  myRelationships(): Promise<CoachingRelationship[]>; // as client AND as coach

  /* relationships (coach side) */
  respondRequest(relationshipId: ID, accept: boolean, message?: string): Promise<void>; // coach only; accepting ends the client's previous active coach
  clientOverview(relationshipId: ID): Promise<ClientOverview>;

  /* programs */
  saveProposal(input: { id: ID; relationshipId: ID; baseProgramId?: ID | null; baseVersion?: number | null; program: ProposedProgram; changeSummary: string[]; message?: string; effectiveDate?: ISODate | null }): Promise<ProgramProposal>; // coach draft, idempotent
  sendProposal(proposalId: ID): Promise<void>; // coach
  withdrawProposal(proposalId: ID): Promise<void>; // coach
  listProposals(filter: { relationshipId?: ID; mine?: boolean; status?: ProposalStatus[] }): Promise<ProgramProposal[]>;
  getProposal(id: ID): Promise<ProgramProposal | null>;
  respondProposal(id: ID, accept: boolean, applied?: { programId: ID; version: number }): Promise<void>; // client; server re-checks base version vs synced program
  addFeedback(input: { id: ID; relationshipId: ID; sessionId?: ID | null; body: string }): Promise<void>; // coach
  listFeedback(relationshipId: ID): Promise<CoachFeedback[]>;

  /* check-ins */
  submitCheckIn(input: { id: ID; relationshipId: ID; answers: CheckIn['answers']; note?: string }): Promise<void>; // client
  listCheckIns(relationshipId: ID): Promise<CheckIn[]>;
  respondCheckIn(id: ID, response: string): Promise<void>; // coach

  /* messaging */
  listMessages(relationshipId: ID, afterSeq?: number, limit?: number): Promise<CoachMessage[]>;
  sendMessage(input: { id: ID; relationshipId: ID; body: string; mediaIds?: ID[]; sharedFromAi?: boolean }): Promise<CoachMessage>; // idempotent on id
  uploadMessageMedia(relationshipId: ID, messageId: ID, mediaId: ID, image: Blob, thumb: Blob): Promise<void>;
  markRead(relationshipId: ID, uptoSeq: number): Promise<void>;
  unreadCoachingCount(): Promise<number>;
  reportCoachingContent(input: { relationshipId: ID; messageId?: ID; reason: string; details?: string }): Promise<void>;

  /* admin (server-checked role 'admin') */
  adminListApplications(status?: ApplicationStatus | 'suspended' | 'qualifications_pending'): Promise<CoachProfile[]>;
  adminGetApplication(coachId: ID): Promise<{ profile: CoachProfile; events: ReviewEvent[] } | null>;
  adminReview(coachId: ID, action: ReviewAction, reason?: string, qualificationId?: ID): Promise<void>;
}

/* ================================================================== AI */
export interface AiScopes {
  profile: boolean; // goals, experience, equipment, exclusions, limitations areas, preferences
  training: boolean; // active program, recent workouts, records
  measurements: boolean; // bodyweight trend
  nutrition: boolean; // targets + recent food log totals
}

export interface AiSettings {
  enabled: boolean;
  paused: boolean;
  consentAt?: string | null;
  /** e.g. "2026-10-29:openai" — the provider the user agreed to. */
  consentVersion?: string | null;
  scopes: AiScopes;
  scopesChangedAt?: string | null;
  /** User-visible, user-editable notes the AI may use. Cleared/edited by the user only. */
  profileNotes: string;
  /** How hard the coach pushes (migration 20261031000001). Missing on older servers → 'balanced'. */
  coachStyle: CoachStyle;
}

export interface AiMessage {
  id: ID;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  status?: 'sent' | 'queued' | 'failed';
  proposalId?: ID | null;
  /** Facts the reply was grounded in (for "based on your records" display). */
  grounding?: string[];
}

export interface AiUsage {
  day: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  limitRequests: number;
}

export type AiProvider = 'anthropic' | 'openai';
/** `provider`/`providerName`: which company the server sends AI requests to (named in consent and data texts).
 *  `consentCurrent: false` = the user agreed for a different provider and must agree again. */
export type AiAvailability =
  | { available: true; provider?: AiProvider; providerName?: string; consentCurrent?: boolean }
  | { available: false; reason: 'not_configured' | 'provider_down' | 'offline' | 'disabled' | 'backend_missing' };

export interface AiApi {
  status(): Promise<AiAvailability & { usage?: AiUsage }>;
  getSettings(): Promise<AiSettings | null>;
  saveSettings(s: Partial<AiSettings> & { acceptConsent?: boolean; provider?: AiProvider }): Promise<AiSettings>;
  history(limit?: number): Promise<AiMessage[]>;
  /** Idempotent on id. Server builds context from the authenticated user's permitted records only. */
  send(input: { id: ID; text: string; mode?: 'chat' | 'checkin_review' }): Promise<{ reply: AiMessage; proposal?: ProgramProposal | null }>;
  clearHistory(): Promise<void>;
  listProposals(): Promise<ProgramProposal[]>;
  respondProposal(id: ID, accept: boolean, applied?: { programId: ID; version: number }): Promise<void>;
}
