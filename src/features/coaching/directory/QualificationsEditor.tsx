import { useRef, useState } from 'react';
import { ExternalLink, FileText, Lock, Plus, Trash2, Upload, X } from 'lucide-react';
import { coachingApi } from '@/backend/coaching';
import { Badge, Button, Card, IconButton, Input, NumberInput } from '@/components/ui';
import { uuid } from '@/lib/id';
import { LIMITS, documentProblem, safeFileName, sniffDocument, type FormErrors, type QualRow } from '@/domain/coaching/application';
import { coachingError } from './common';

const REVIEW_BADGE: Record<NonNullable<QualRow['reviewStatus']>, { label: string; tone: 'accent' | 'warn' | 'danger' }> = {
  pending: { label: 'Waiting for review', tone: 'warn' },
  approved: { label: 'Reviewed', tone: 'accent' },
  rejected: { label: 'Not accepted', tone: 'danger' },
};

export function QualificationsEditor({ rows, onChange, errors, disabled }: { rows: QualRow[]; onChange: (r: QualRow[]) => void; errors: FormErrors; disabled?: boolean }) {
  const update = (id: string, patch: Partial<QualRow>) => onChange(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  return (
    <div className="flex flex-col gap-3">
      {rows.length === 0 && <p className="text-sm text-muted px-1">Optional. Add certificates or courses you’d like reviewed. Only reviewed qualifications appear on your public profile.</p>}
      {rows.map((q, i) => (
        <QualRowEditor key={q.id} index={i} row={q} errors={errors} disabled={disabled} onChange={(p) => update(q.id, p)} onRemove={() => onChange(rows.filter((r) => r.id !== q.id))} />
      ))}
      <Button
        size="sm"
        variant="outline"
        className="self-start"
        icon={<Plus className="size-4" />}
        disabled={disabled || rows.length >= LIMITS.qualifications}
        onClick={() => onChange([...rows, { id: uuid(), title: '', issuer: '', year: null, documentPath: null, documentName: null }])}
      >
        Add qualification
      </Button>
      <p className="text-xs text-muted px-1 inline-flex items-start gap-1.5">
        <Lock className="size-3.5 shrink-0 mt-0.5" aria-hidden />
        Documents are private: only you and Hard Earned reviewers can open them. Clients never see the files.
      </p>
    </div>
  );
}

function QualRowEditor({ index, row, errors, disabled, onChange, onRemove }: { index: number; row: QualRow; errors: FormErrors; disabled?: boolean; onChange: (p: Partial<QualRow>) => void; onRemove: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [docError, setDocError] = useState<string | null>(null);
  const [viewUrl, setViewUrl] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const e = (f: string) => errors[`qualifications.${index}.${f}`] ?? null;
  const badge = row.reviewStatus ? REVIEW_BADGE[row.reviewStatus] : null;

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setDocError(null);
    setViewUrl(null);
    try {
      const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
      const problem = documentProblem(file, head);
      if (problem) {
        setDocError(problem);
        return;
      }
      setUploading(true);
      const path = await coachingApi.uploadQualificationDocument(row.id, file, safeFileName(file.name, sniffDocument(head)!));
      onChange({ documentPath: path, documentName: file.name.slice(0, 120) });
    } catch (err) {
      setDocError(coachingError(err, 'The document couldn’t be uploaded. Please try again.'));
    } finally {
      setUploading(false);
    }
  };

  const open = async () => {
    if (!row.documentPath) return;
    setOpening(true);
    setDocError(null);
    try {
      setViewUrl(await coachingApi.documentUrl(row.documentPath));
    } catch (err) {
      setDocError(coachingError(err, 'Couldn’t open the document.'));
    } finally {
      setOpening(false);
    }
  };

  return (
    <Card className="p-3 flex flex-col gap-3" role="group" aria-label={`Qualification ${index + 1}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">Qualification {index + 1}</span>
        <div className="flex items-center gap-1">
          {badge && <Badge tone={badge.tone}>{badge.label}</Badge>}
          <IconButton label={`Remove qualification ${index + 1}`} onClick={onRemove} disabled={disabled} className="text-muted">
            <Trash2 className="size-5" />
          </IconButton>
        </div>
      </div>
      {row.reviewStatus === 'rejected' && row.reviewNote && <p className="text-xs text-danger">Reviewer note: {row.reviewNote}</p>}
      <Input label="Title" value={row.title} maxLength={LIMITS.qualTitle} onChange={(ev) => onChange({ title: ev.target.value })} error={e('title')} placeholder="e.g. Level 3 Personal Trainer" disabled={disabled} />
      <div className="grid grid-cols-[1fr_7rem] gap-3">
        <Input label="Issued by (optional)" value={row.issuer} maxLength={LIMITS.qualIssuer} onChange={(ev) => onChange({ issuer: ev.target.value })} error={e('issuer')} disabled={disabled} />
        <NumberInput label="Year" value={row.year} decimals={false} min={1950} max={new Date().getFullYear() + 1} onChange={(v) => onChange({ year: v })} error={e('year')} placeholder="2021" />
      </div>
      <div className="flex flex-col gap-2">
        {row.documentPath ? (
          <div className="flex items-center gap-2 rounded-xl bg-surface-2 border border-line px-3 py-2">
            <FileText className="size-4 text-muted shrink-0" aria-hidden />
            <span className="text-sm min-w-0 flex-1 truncate">{row.documentName || 'Document'}</span>
            <Button size="sm" variant="ghost" loading={opening} onClick={() => void open()}>
              View
            </Button>
            <IconButton
              size="sm"
              label="Remove document"
              disabled={disabled}
              onClick={() => {
                setViewUrl(null);
                onChange({ documentPath: null, documentName: null });
              }}
            >
              <X className="size-4" />
            </IconButton>
          </div>
        ) : (
          <Button size="sm" variant="ghost" className="self-start" icon={<Upload className="size-4" />} loading={uploading} disabled={disabled} onClick={() => fileRef.current?.click()}>
            Attach document (optional)
          </Button>
        )}
        <input
          ref={fileRef}
          type="file"
          accept="application/pdf,image/jpeg,image/png,.pdf,.jpg,.jpeg,.png"
          className="sr-only"
          tabIndex={-1}
          aria-hidden
          onChange={(ev) => {
            void pick(ev.target.files?.[0]);
            ev.target.value = '';
          }}
        />
        <p className="text-xs text-muted">PDF, JPG or PNG, up to 10 MB. Save your profile to keep the attachment.</p>
        {viewUrl && (
          <a href={viewUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-sm text-accent font-medium min-h-11">
            <ExternalLink className="size-4" aria-hidden />
            Open document (link expires shortly)
          </a>
        )}
        {docError && (
          <p role="alert" className="text-xs text-danger">
            {docError}
          </p>
        )}
      </div>
    </Card>
  );
}
