import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { ChevronLeft, Copy, Layers, Play, Plus } from 'lucide-react';
import { useApp } from '@/state/app';
import { alive, deleteRecord, newRecord, saveRecord } from '@/db/repo';
import { Button, EmptyState, IconButton, Input, Page, Sheet, Spinner } from '@/components/ui';
import { useExercises } from '@/data/catalog';
import { displaySessionName, SessionCard } from '@/features/program/parts';
import { emptyTemplate } from '@/domain/program/generator';
import type { SavedTemplate, SyncFields } from '@/domain/types';
import { uuid } from '@/lib/id';
import { useStarters } from './hooks';
import { useToast } from '@/components/toast';
import { useT } from '@/i18n';

export default function TemplatesPage() {
  const nav = useNavigate();
  const toast = useToast();
  const { t } = useT();
  const { db, account } = useApp();
  const { byId, list } = useExercises();
  const templates = useLiveQuery(async () => alive(await db.templates.toArray()).sort((a, b) => b.updatedAt - a.updatedAt), [db]);
  const { startTemplate } = useStarters();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');

  if (!templates) return <Spinner />;

  // The copy's name is new text the user owns (localized suffix at creation, then shown as stored).
  const duplicate = (st: SavedTemplate) =>
    void saveRecord(
      'templates',
      newRecord<Omit<SavedTemplate, keyof SyncFields>>({ template: { ...st.template, id: uuid(), name: t('workout.savedTemplate.copyName', { name: displaySessionName(st.template) }), nameEdited: true } }) as SavedTemplate,
      db,
    ).then(() => toast.show(t('workout.savedTemplate.template_duplicated')));

  return (
    <Page
      title={t('train.templateTitle')}
      back={
        <IconButton label={t('common.back')} onClick={() => nav(-1)}>
          <ChevronLeft className="size-6" />
        </IconButton>
      }
      actions={
        <Button size="sm" variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
          {t('social.new')}
        </Button>
      }
    >
      {templates.length === 0 ? (
        <EmptyState
          icon={<Layers className="size-6" />}
          title={t('workout.savedTemplate.no_saved_templates')}
          body={t('workout.savedTemplate.create_a_routine_here_save_one')}
          action={<Button variant="primary" onClick={() => setCreating(true)}>{t('workout.savedTemplate.create_template')}</Button>}
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
                onChange={(next) => void saveRecord('templates', { ...st, template: next }, db)}
                onDuplicate={() =>
                  duplicate(st)
                }
                onDelete={() => void deleteRecord('templates', st.id, db).then(() => toast.show(t('activities.form.template_deleted')))}
              />
              <div className="flex gap-2 mt-1.5 px-1">
                <Button size="sm" variant="primary" icon={<Play className="size-4" />} disabled={st.template.exercises.length === 0} onClick={() => void startTemplate(st.template)}>
                  {t('common.start')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<Copy className="size-4" />}
                  onClick={() =>
                    duplicate(st)
                  }
                >
                  {t('workout.savedTemplate.duplicate')}
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
      <Sheet
        open={creating}
        onClose={() => setCreating(false)}
        title={t('coaching.dashboard.new_template')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreating(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={!name.trim()}
              onClick={async () => {
                await saveRecord('templates', newRecord<Omit<SavedTemplate, keyof SyncFields>>({ template: emptyTemplate(uuid(), name.trim()) }) as SavedTemplate, db);
                setCreating(false);
                setName('');
                toast.show(t('workout.savedTemplate.template_created_add_exercises_below'), { tone: 'success' });
              }}
            >
              {t('workout.savedTemplate.create')}
            </Button>
          </>
        }
      >
        <Input label={t('workout.custom.name')} placeholder={t('workout.savedTemplate.e_g_upper_body_home')} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} autoFocus />
      </Sheet>
    </Page>
  );
}
