/**
 * Coach application / profile form model: conversion to and from the API shape, draft validation (formats and
 * lengths, zod) and a client-side mirror of the server's submit rules. Pure.
 */
import { z } from 'zod';
import type { ApplicationStatus, CoachFormat, CoachProfile, CoachProfileInput, Qualification, ServiceArea } from '@/backend/coachingContract';
import { t as tr } from '@/i18n';
import { isCountryCode } from './options';

export const LIMITS = {
  displayName: 60,
  bio: 2000,
  bioMinToSubmit: 40, // same as submit_coach_application (server is the authority)
  experience: 4000,
  experienceYears: 70,
  specialties: 10,
  goals: 8,
  languages: 10,
  tag: 40,
  place: 80,
  serviceAreas: 20,
  qualifications: 20,
  qualTitle: 120,
  qualIssuer: 120,
  radiusKmMax: 500,
  documentBytes: 10 * 1024 * 1024,
} as const;

export interface AreaRow {
  key: string; // local React key
  id?: string;
  kind: ServiceArea['kind'];
  city: string;
  region: string;
  country: string;
  /** Only ever set from a geocoder result — never typed. */
  lat: number | null;
  lng: number | null;
  radiusKm: number | null;
  label: string | null;
}

export interface QualRow {
  id: string;
  title: string;
  issuer: string;
  year: number | null;
  documentPath: string | null;
  documentName: string | null;
  /** Server state (display only). New rows are pending once saved. */
  reviewStatus?: Qualification['reviewStatus'];
  reviewNote?: string | null;
}

export interface ApplicationForm {
  displayName: string;
  photoPath: string | null;
  bio: string;
  experienceYears: number | null;
  experience: string;
  specialties: string[];
  goals: string[];
  languages: string[];
  city: string;
  region: string;
  country: string;
  formats: CoachFormat[];
  acceptingClients: boolean;
  listed: boolean;
  serviceAreas: AreaRow[];
  qualifications: QualRow[];
}

let keySeq = 0;
export const newAreaKey = () => `area-${Date.now().toString(36)}-${(keySeq++).toString(36)}`;

export function emptyArea(country = ''): AreaRow {
  return { key: newAreaKey(), kind: 'city', city: '', region: '', country, lat: null, lng: null, radiusKm: null, label: null };
}

export function formFromProfile(p: CoachProfile | null, defaults: { displayName?: string; country?: string } = {}): ApplicationForm {
  if (!p) {
    return {
      displayName: defaults.displayName?.trim() ?? '',
      photoPath: null,
      bio: '',
      experienceYears: null,
      experience: '',
      specialties: [],
      goals: [],
      languages: [],
      city: '',
      region: '',
      country: defaults.country ?? '',
      formats: [],
      acceptingClients: true,
      listed: true,
      serviceAreas: [],
      qualifications: [],
    };
  }
  return {
    displayName: p.displayName ?? '',
    photoPath: p.photoPath ?? null,
    bio: p.bio ?? '',
    experienceYears: p.experienceYears ?? null,
    experience: p.experience ?? '',
    specialties: [...(p.specialties ?? [])],
    goals: [...(p.goals ?? [])],
    languages: [...(p.languages ?? [])],
    city: p.city ?? '',
    region: p.region ?? '',
    country: p.country ?? '',
    formats: [...(p.formats ?? [])],
    acceptingClients: p.acceptingClients,
    listed: p.listed,
    serviceAreas: (p.serviceAreas ?? []).map((a) => ({
      key: a.id || newAreaKey(),
      id: a.id,
      kind: a.kind,
      city: a.city ?? '',
      region: a.region ?? '',
      country: a.country ?? '',
      lat: a.lat ?? null,
      lng: a.lng ?? null,
      radiusKm: a.radiusKm ?? null,
      label: a.label ?? null,
    })),
    qualifications: (p.qualifications ?? []).map((q) => ({
      id: q.id,
      title: q.title,
      issuer: q.issuer ?? '',
      year: q.year ?? null,
      documentPath: q.documentPath ?? null,
      documentName: q.documentName ?? null,
      reviewStatus: q.reviewStatus,
      reviewNote: q.reviewNote ?? null,
    })),
  };
}

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
const nn = (s: string) => (squash(s) ? squash(s) : null);

export function formToInput(f: ApplicationForm): CoachProfileInput {
  return {
    displayName: squash(f.displayName),
    photoPath: f.photoPath,
    bio: f.bio.trim(),
    experienceYears: f.experienceYears,
    experience: f.experience.trim(),
    specialties: [...new Set(f.specialties)],
    goals: [...new Set(f.goals)],
    languages: [...new Set(f.languages)],
    city: nn(f.city),
    region: nn(f.region),
    country: f.country ? f.country.toUpperCase() : null,
    formats: [...new Set(f.formats)],
    acceptingClients: f.acceptingClients,
    listed: f.listed,
    serviceAreas: f.serviceAreas.map((a) => {
      const geo = a.lat != null && a.lng != null;
      return {
        ...(a.id ? { id: a.id } : {}),
        kind: a.kind,
        city: a.kind === 'city' ? nn(a.city) : null,
        region: a.kind === 'country' ? null : nn(a.region),
        country: a.country.toUpperCase(),
        lat: geo ? a.lat : null,
        lng: geo ? a.lng : null,
        radiusKm: geo ? a.radiusKm : null,
        label: geo ? a.label : null,
      };
    }),
    qualifications: f.qualifications.map((q) => ({
      id: q.id,
      title: squash(q.title),
      issuer: nn(q.issuer),
      year: q.year,
      documentPath: q.documentPath,
      documentName: q.documentName,
    })),
  };
}

/* -------------------------------------------------------------- validation */
const thisYear = () => new Date().getFullYear();
const atMostChars = (max: number) => tr('coaching.validation.at_most_chars', { max });

/** Built per call so messages are in the current language. */
function areaSchema() {
  return z
    .object({
      kind: z.enum(['city', 'region', 'country']),
      city: z.string().max(LIMITS.place, atMostChars(LIMITS.place)),
      region: z.string().max(LIMITS.place, atMostChars(LIMITS.place)),
      country: z.string().refine((c) => isCountryCode(c), tr('coaching.validation.choose_a_country')),
      lat: z.number().min(-90).max(90).nullable(),
      lng: z.number().min(-180).max(180).nullable(),
      radiusKm: z
        .number()
        .int(tr('coaching.validation.use_whole_kilometres'))
        .min(1, tr('coaching.validation.at_least_1_km'))
        .max(LIMITS.radiusKmMax, tr('coaching.validation.at_most_km', { max: LIMITS.radiusKmMax }))
        .nullable(),
    })
    .superRefine((a, ctx) => {
      if (a.kind === 'city' && !squash(a.city)) ctx.addIssue({ code: 'custom', path: ['city'], message: tr('ui.add_the_city_or_town') });
      if (a.kind === 'region' && !squash(a.region)) ctx.addIssue({ code: 'custom', path: ['region'], message: tr('ui.add_the_region') });
      if ((a.lat == null) !== (a.lng == null)) ctx.addIssue({ code: 'custom', path: ['lat'], message: tr('ui.map_position_is_incomplete_look_the') });
    });
}

function qualSchema() {
  const year = tr('coaching.validation.use_a_four_digit_year');
  return z.object({
    title: z
      .string()
      .refine((s) => squash(s).length >= 2, tr('coaching.validation.add_the_qualifications_title'))
      .refine((s) => squash(s).length <= LIMITS.qualTitle, tr('coaching.validation.at_most_chars', { max: LIMITS.qualTitle })),
    issuer: z.string().max(LIMITS.qualIssuer, atMostChars(LIMITS.qualIssuer)),
    year: z
      .number()
      .int(year)
      .min(1950, year)
      .refine((y) => y <= thisYear() + 1, tr('coaching.validation.that_year_is_in_the_future'))
      .nullable(),
  });
}

const tag = z.string().min(1).max(LIMITS.tag);

/** Draft (format/length) schema; built per call so its messages follow the current language. */
export function draftSchema() {
  const pickUpTo = (max: number) => tr('coaching.validation.pick_up_to', { max });
  return z.object({
    displayName: z.string().refine((s) => squash(s).length <= LIMITS.displayName, tr('coaching.validation.at_most_chars', { max: LIMITS.displayName })),
    bio: z.string().max(LIMITS.bio, atMostChars(LIMITS.bio)),
    experienceYears: z
      .number()
      .int(tr('coaching.validation.use_whole_years'))
      .min(0, tr('coaching.validation.cant_be_negative'))
      .max(LIMITS.experienceYears, tr('coaching.validation.at_most', { max: LIMITS.experienceYears }))
      .nullable(),
    experience: z.string().max(LIMITS.experience, atMostChars(LIMITS.experience)),
    specialties: z.array(tag).max(LIMITS.specialties, pickUpTo(LIMITS.specialties)),
    goals: z.array(tag).max(LIMITS.goals, pickUpTo(LIMITS.goals)),
    languages: z.array(z.string().regex(/^[a-z]{2}$/)).max(LIMITS.languages, pickUpTo(LIMITS.languages)),
    city: z.string().max(LIMITS.place, atMostChars(LIMITS.place)),
    region: z.string().max(LIMITS.place, atMostChars(LIMITS.place)),
    country: z.string().refine((c) => c === '' || isCountryCode(c), tr('coaching.validation.choose_a_country_from_the_list')),
    formats: z.array(z.enum(['in_person', 'online'])).refine((a) => new Set(a).size === a.length, tr('coaching.validation.duplicate_format')),
    acceptingClients: z.boolean(),
    listed: z.boolean(),
    photoPath: z.string().nullable(),
    serviceAreas: z.array(areaSchema()).max(LIMITS.serviceAreas, tr('coaching.validation.add_up_to_areas', { max: LIMITS.serviceAreas })),
    qualifications: z.array(qualSchema()).max(LIMITS.qualifications, tr('coaching.validation.add_up_to', { max: LIMITS.qualifications })),
  });
}

export type FormErrors = Record<string, string>;

/** Format/length checks that apply to every save (drafts may be incomplete). Keys are dotted paths. */
export function validateDraft(f: ApplicationForm): FormErrors {
  const r = draftSchema().safeParse(f);
  if (r.success) return {};
  const errs: FormErrors = {};
  for (const issue of r.error.issues) {
    const k = issue.path.map(String).join('.') || 'form';
    if (!errs[k]) errs[k] = issue.message;
  }
  return errs;
}

/**
 * Mirror of the server's submit rules (the server re-checks). Returns field-keyed messages; empty = ready.
 */
export function submitProblems(f: ApplicationForm): FormErrors {
  const errs: FormErrors = { ...validateDraft(f) };
  const add = (k: string, m: string) => void (errs[k] ??= m);
  if (squash(f.displayName).length < 2) add('displayName', tr('coaching.validation.add_the_name_clients_will_see'));
  if (f.bio.trim().length < LIMITS.bioMinToSubmit) add('bio', tr('coaching.validation.write_at_least_about_how_you_coach', { min: LIMITS.bioMinToSubmit }));
  if (f.specialties.length === 0) add('specialties', tr('coaching.validation.pick_at_least_one_specialty'));
  if (f.languages.length === 0) add('languages', tr('coaching.validation.pick_at_least_one_language'));
  if (!f.country) add('country', tr('coaching.validation.choose_the_country_you_coach_from'));
  if (f.formats.length === 0) add('formats', tr('coaching.validation.choose_in_person_online_or_both'));
  if (f.formats.includes('in_person') && f.serviceAreas.length === 0) add('serviceAreas', tr('coaching.validation.add_at_least_one_in_person_area'));
  return errs;
}

export const canSubmitFrom = (s: ApplicationStatus | null | undefined) => s == null || s === 'draft' || s === 'changes_requested' || s === 'rejected';

/** Approved qualifications whose reviewed details changed in the form — saving sends them back for review. */
export function changedApprovedQualifications(f: ApplicationForm, original: CoachProfile | null): string[] {
  if (!original) return [];
  const byId = new Map(original.qualifications.map((q) => [q.id, q]));
  const changed: string[] = [];
  for (const row of f.qualifications) {
    const q = byId.get(row.id);
    if (!q || q.reviewStatus !== 'approved') continue;
    if (squash(row.title) !== squash(q.title) || (nn(row.issuer) ?? null) !== (q.issuer ? squash(q.issuer) : null) || (row.year ?? null) !== (q.year ?? null) || (row.documentPath ?? null) !== (q.documentPath ?? null)) changed.push(row.id);
  }
  return changed;
}

/* --------------------------------------------------------------- documents */
export type DocKind = 'pdf' | 'png' | 'jpeg';

export function sniffDocument(head: Uint8Array): DocKind | null {
  if (head.length >= 5 && head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46 && head[4] === 0x2d) return 'pdf';
  if (head.length >= 8 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return 'png';
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpeg';
  return null;
}

/** Checks a qualification document before upload. Returns a message or null when acceptable. */
export function documentProblem(file: { size: number; name: string }, head: Uint8Array): string | null {
  if (file.size === 0) return tr('coaching.validation.file_empty');
  if (file.size > LIMITS.documentBytes) return tr('coaching.validation.file_too_large');
  if (!sniffDocument(head)) return tr('coaching.validation.file_type');
  return null;
}

/** Safe file name for storage: keeps letters/numbers/dot/dash/underscore. */
export function safeFileName(name: string, kind: DocKind): string {
  const ext = kind === 'jpeg' ? 'jpg' : kind;
  const base = name.replace(/\.[^.]*$/, '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^\w.-]+/g, '_').replace(/_+/g, '_').replace(/^[_.]+|[_.]+$/g, '').slice(0, 60) || 'document';
  return `${base}.${ext}`;
}
