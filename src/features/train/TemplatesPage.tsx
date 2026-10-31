import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { ChevronLeft, Copy, Layers, Play, Plus } from 'lucide-react';
import { useApp } from '@/state/app';
import { alive, deleteRecord, newRecord, saveRecord } from '@/db/repo';
import { Button, EmptyState, IconButton, Input, Page, Sheet, Spinner } from '@/components/ui';
import { useExercises } from '@/data/catalog';
import { SessionCard } from '@/features/program/parts';
import { emptyTemplate } from '@/domain/program/generator';
import type { SavedTemplate, SyncFields } from '@/domain/types';
import { uuid } from '@/lib/id';
import { useStarters } from './hooks';
import { useToast } from '@/components/toast';

export default function TemplatesPage() {
  const nav = useNavigate();
  const toast = useToast();
  const { db, account } = useApp();
  const { byId, list } = useExercises();
  const templates = useLiveQuery(async () => alive(await db.templates.toArray()).sort((a, b) => b.updatedAt - a.updatedAt), [db]);
  const { startTemplate } = useStarters();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');

  if (!templates) return <Spinner />;

  return (
    <Page
      title="Templates"
      back={
        <IconButton label="Back" onClick={() => nav(-1)}>
          <ChevronLeft className="size-6" />
        </IconButton>
      }
      actions={
        <Button size="sm" variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
          New
        </Button>
      }
    >
      {templates.length === 0 ? (
        <EmptyState
          icon={<Layers className="size-6" />}
          title="No saved templates"
          body="Create a routine here, save one from a finished workout, or duplicate a session from your program."
          action={<Button variant="primary" onClick={() => setCreating(true)}>Create template</Button>}
        />
      ) : (
        <div className="space-y-3">
          {templates.map((st) => (
            <div key={st.id}>
              <SessionCard
                template={st.template}
                byId={byId}
                catalog={list}
                unit={account.settings.units.weight}
                editable
                defaultOpen={false}
                onChange={(t) => void saveRecord('templates', { ...st, template: t }, db)}
                onDuplicate={() =>
                  void saveRecord('templates', newRecord<Omit<SavedTemplate, keyof SyncFields>>({ template: { ...st.template, id: uuid(), name: `${st.template.name} (copy)` } }) as SavedTemplate, db).then(() => toast.show('Template duplicated'))
                }
                onDelete={() => void deleteRecord('templates', st.id, db).then(() => toast.show('Template deleted'))}
              />
              <div className="flex gap-2 mt-1.5 px-1">
                <Button size="sm" variant="primary" icon={<Play className="size-4" />} disabled={st.template.exercises.length === 0} onClick={() => void startTemplate(st.template)}>
                  Start
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<Copy className="size-4" />}
                  onClick={() =>
                    void saveRecord('templates', newRecord<Omit<SavedTemplate, keyof SyncFields>>({ template: { ...st.template, id: uuid(), name: `${st.template.name} (copy)` } }) as SavedTemplate, db).then(() => toast.show('Template duplicated'))
                  }
                >
                  Duplicate
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
      <Sheet
        open={creating}
        onClose={() => setCreating(false)}
        title="New template"
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreating(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!name.trim()}
              onClick={async () => {
                await saveRecord('templates', newRecord<Omit<SavedTemplate, keyof SyncFields>>({ template: emptyTemplate(uuid(), name.trim()) }) as SavedTemplate, db);
                setCreating(false);
                setName('');
                toast.show('Template created: add exercises below', { tone: 'success' });
              }}
            >
              Create
            </Button>
          </>
        }
      >
        <Input label="Name" placeholder="e.g. Upper body – home" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} autoFocus />
      </Sheet>
    </Page>
  );
}
