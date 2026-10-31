import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';
import { AlertTriangle, ArrowDown, ArrowUp, Camera, ImagePlus, Loader2, X } from 'lucide-react';
import { Button, IconButton, Input } from '@/components/ui';
import { uuid } from '@/lib/id';
import { mediaErrorMessage, processImage, type ProcessedImage } from '@/social/media';

export const MAX_PHOTOS = 4;
export const DESCRIPTION_MAX = 300;

export interface PickedPhoto {
  /** Also used as the media id on the server. */
  id: string;
  name: string;
  status: 'processing' | 'ready' | 'error';
  error?: string;
  processed?: ProcessedImage;
  previewUrl?: string;
  description: string;
}

/** State + processing queue for up to `max` photos. Images are processed one at a time to bound memory. */
export function usePhotoPicker(max = MAX_PHOTOS) {
  const [photos, setPhotos] = useState<PickedPhoto[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const ref = useRef(photos);
  ref.current = photos;
  const queue = useRef<Promise<void>>(Promise.resolve());
  const urls = useRef(new Set<string>());

  useEffect(
    () => () => {
      urls.current.forEach((u) => URL.revokeObjectURL(u));
      urls.current.clear();
    },
    [],
  );

  const patch = (id: string, p: Partial<PickedPhoto>) => setPhotos((cur) => cur.map((x) => (x.id === id ? { ...x, ...p } : x)));

  const add = useCallback(
    (files: FileList | File[] | null) => {
      if (!files) return;
      const list = Array.from(files);
      const free = max - ref.current.length;
      if (free <= 0) {
        setNotice(`A post can have up to ${max} photos.`);
        return;
      }
      const chosen = list.slice(0, free);
      setNotice(list.length > free ? `A post can have up to ${max} photos. The first ${free === 1 ? 'one was' : `${free} were`} added.` : null);
      const items: PickedPhoto[] = chosen.map((f) => ({ id: uuid(), name: f.name || 'Photo', status: 'processing', description: '' }));
      setPhotos((cur) => [...cur, ...items]);
      chosen.forEach((file, i) => {
        const id = items[i].id;
        queue.current = queue.current.then(async () => {
          if (!ref.current.some((x) => x.id === id)) return; // removed while waiting
          try {
            const processed = await processImage(file);
            if (!ref.current.some((x) => x.id === id)) return;
            const previewUrl = URL.createObjectURL(processed.thumb);
            urls.current.add(previewUrl);
            patch(id, { status: 'ready', processed, previewUrl });
          } catch (e) {
            patch(id, { status: 'error', error: mediaErrorMessage(e) });
          }
        });
      });
    },
    [max],
  );

  const remove = useCallback((id: string) => {
    const p = ref.current.find((x) => x.id === id);
    if (p?.previewUrl) {
      URL.revokeObjectURL(p.previewUrl);
      urls.current.delete(p.previewUrl);
    }
    setNotice(null);
    setPhotos((cur) => cur.filter((x) => x.id !== id));
  }, []);

  const move = useCallback((id: string, dir: -1 | 1) => {
    setPhotos((cur) => {
      const i = cur.findIndex((x) => x.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= cur.length) return cur;
      const next = [...cur];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }, []);

  const describe = useCallback((id: string, description: string) => patch(id, { description: description.slice(0, DESCRIPTION_MAX) }), []);

  return {
    photos,
    notice,
    add,
    remove,
    move,
    describe,
    max,
    processing: photos.some((p) => p.status === 'processing'),
    hasErrors: photos.some((p) => p.status === 'error'),
    ready: photos.filter((p): p is PickedPhoto & { processed: ProcessedImage } => p.status === 'ready' && !!p.processed),
  };
}

export type PhotoPickerState = ReturnType<typeof usePhotoPicker>;

export function PhotoPicker({ picker, disabled }: { picker: PhotoPickerState; disabled?: boolean }) {
  const libraryRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const full = picker.photos.length >= picker.max;
  const onFiles = (e: ChangeEvent<HTMLInputElement>) => {
    picker.add(e.target.files);
    e.target.value = ''; // allow choosing the same file again
  };
  return (
    <div>
      <div className="flex flex-wrap gap-2">
        <Button icon={<ImagePlus className="size-4" />} onClick={() => libraryRef.current?.click()} disabled={disabled || full}>
          Choose photos
        </Button>
        <Button icon={<Camera className="size-4" />} onClick={() => cameraRef.current?.click()} disabled={disabled || full}>
          Take photo
        </Button>
        <input ref={libraryRef} type="file" accept="image/*" multiple className="sr-only" tabIndex={-1} aria-hidden onChange={onFiles} />
        <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="sr-only" tabIndex={-1} aria-hidden onChange={onFiles} />
      </div>
      <p className="text-xs text-muted mt-2">
        Up to {picker.max} photos. Location and camera details are removed before upload.
      </p>
      {picker.notice && (
        <p role="status" className="text-xs text-warn mt-1">
          {picker.notice}
        </p>
      )}

      {picker.photos.length > 0 && (
        <ol className="mt-3 flex flex-col gap-3" aria-label="Selected photos">
          {picker.photos.map((p, i) => (
            <li key={p.id} className="flex gap-3 items-start rounded-xl border border-line bg-surface-2 p-2">
              <div className="size-20 shrink-0 rounded-lg bg-surface-3 overflow-hidden flex items-center justify-center">
                {p.status === 'ready' && p.previewUrl ? (
                  <img src={p.previewUrl} alt={p.description || `Selected photo ${i + 1}`} className="size-full object-cover" />
                ) : p.status === 'processing' ? (
                  <Loader2 className="size-5 animate-spin text-muted" aria-label="Preparing photo" />
                ) : (
                  <AlertTriangle className="size-5 text-danger" aria-hidden />
                )}
              </div>
              <div className="min-w-0 flex-1">
                {p.status === 'error' ? (
                  <div role="alert">
                    <p className="text-sm font-medium truncate">{p.name}</p>
                    <p className="text-xs text-danger mt-0.5">{p.error}</p>
                  </div>
                ) : (
                  <Input
                    label={<span className="text-xs text-muted font-normal">Photo {i + 1} description (optional)</span>}
                    placeholder="What’s in the photo?"
                    value={p.description}
                    maxLength={DESCRIPTION_MAX}
                    disabled={disabled}
                    onChange={(e) => picker.describe(p.id, e.target.value)}
                  />
                )}
              </div>
              <div className="flex flex-col shrink-0">
                <IconButton label={`Remove photo ${i + 1}`} onClick={() => picker.remove(p.id)} disabled={disabled}>
                  <X className="size-5" />
                </IconButton>
                {picker.photos.length > 1 && (
                  <>
                    <IconButton label={`Move photo ${i + 1} up`} onClick={() => picker.move(p.id, -1)} disabled={disabled || i === 0}>
                      <ArrowUp className="size-4" />
                    </IconButton>
                    <IconButton label={`Move photo ${i + 1} down`} onClick={() => picker.move(p.id, 1)} disabled={disabled || i === picker.photos.length - 1}>
                      <ArrowDown className="size-4" />
                    </IconButton>
                  </>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
