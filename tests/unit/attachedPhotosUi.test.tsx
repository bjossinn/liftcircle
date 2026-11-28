// @vitest-environment jsdom
/** Messages composer, attached-photo state: each remove control is a real 44 × 44 px target that the scrollport doesn't clip. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { AttachedPhotos } from '@/features/coaching/MessagesPage';
import { IS, LanguageProvider, setLanguage } from '@/i18n';

let root: Root | null = null;
let el: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  el?.remove();
  setLanguage('en');
});

async function render(photos: { id: string; url: string }[], onRemove = vi.fn(), preparing = 0) {
  setLanguage('is');
  el = document.createElement('div');
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(createElement(LanguageProvider, { language: 'is', children: createElement(AttachedPhotos, { photos, preparing, onRemove }) })));
  return onRemove;
}

describe('AttachedPhotos', () => {
  it('renders nothing without photos', async () => {
    await render([]);
    expect(el!.querySelector('ul')).toBeNull();
  });

  it('remove buttons are 44 px boxes inside the padded scrollport and remove the right photo', async () => {
    const onRemove = await render([{ id: 'a', url: 'blob:a' }, { id: 'b', url: 'blob:b' }]);
    const list = el!.querySelector('ul')!;
    expect(list.className).toContain('overflow-x-auto');
    const buttons = [...el!.querySelectorAll<HTMLButtonElement>('[data-testid="remove-photo"]')];
    expect(buttons).toHaveLength(2);
    for (const b of buttons) {
      const cls = b.className.split(/\s+/);
      // size-11 = 2.75rem = 44 px: the button box itself is the target (no pseudo-element expansion).
      expect(cls).toContain('size-11');
      expect(b.className).not.toMatch(/after:/);
      // The target reaches 14 px (3.5) beyond the thumbnail's top/right edge; the list pads exactly that much.
      expect(cls).toEqual(expect.arrayContaining(['-top-3.5', '-right-3.5']));
    }
    expect(list.className.split(/\s+/)).toEqual(expect.arrayContaining(['pt-3.5', 'pr-3.5']));
    expect(buttons[1].getAttribute('aria-label')).toBe(IS['coaching.messages.remove_photo_x'].replace('{{n}}', '2'));
    await act(async () => buttons[1].click());
    expect(onRemove).toHaveBeenCalledWith('b');
  });
});
