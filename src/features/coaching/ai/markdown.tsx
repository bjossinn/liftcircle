/**
 * Safe Markdown subset for AI coach messages and "Why this?" text (only in the lazy AI chat chunk).
 *
 * Supported: paragraphs and line breaks, **bold**, *italic* / _italic_, ~~strike~~, `inline code`, bulleted and
 * numbered lists (one nesting level), blockquotes, headings (shown as a bold line) and https:// links (new tab,
 * rel="noopener noreferrer"). Everything else is plain text: raw HTML, images (their alt text), tables, code fences
 * (their content), and any non-https link (javascript:, data:, http:, relative) keeps only its label.
 *
 * Output is built from React elements and text nodes only — no innerHTML anywhere — so a model reply can never
 * inject markup or script. Messages are stored unchanged; this only affects display.
 */
import { Fragment, type ReactNode } from 'react';

/* ------------------------------------------------------------------ inline */
export type Inline =
  | { t: 'text'; v: string }
  | { t: 'b' | 'i' | 's'; c: Inline[] }
  | { t: 'code'; v: string }
  | { t: 'a'; href: string; c: Inline[] }
  | { t: 'br' };

const SAFE_HREF = /^https:\/\/[^\s<>"'`]+$/i;
/** Only absolute https URLs become links. */
export function safeHref(raw: string): string | null {
  const href = raw.trim();
  if (!SAFE_HREF.test(href)) return null;
  try {
    const u = new URL(href);
    return u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

const BARE_URL = /https:\/\/[^\s<>"'`)\]]+[^\s<>"'`)\].,;:!?]/;

function pushText(out: Inline[], v: string) {
  if (!v) return;
  const last = out[out.length - 1];
  if (last && last.t === 'text') last.v += v;
  else out.push({ t: 'text', v });
}

/** Finds the closing delimiter that isn't escaped and leaves non-empty content. */
function closing(s: string, from: number, delim: string): number {
  let i = s.indexOf(delim, from);
  while (i >= 0) {
    if (i > from && s[i - 1] !== '\\' && s[i - 1] !== ' ') return i;
    i = s.indexOf(delim, i + 1);
  }
  return -1;
}

export function parseInline(s: string, depth = 0): Inline[] {
  const out: Inline[] = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    const rest = s.slice(i);
    // escaped marker → literal
    if (ch === '\\' && i + 1 < s.length && /[\\`*_~[\]()!#>-]/.test(s[i + 1])) {
      pushText(out, s[i + 1]);
      i += 2;
      continue;
    }
    if (ch === '`') {
      const end = s.indexOf('`', i + 1);
      if (end > i + 1) {
        out.push({ t: 'code', v: s.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if (depth < 4) {
      let matched = false;
      for (const [delim, t] of [['**', 'b'], ['__', 'b'], ['~~', 's']] as const) {
        if (rest.startsWith(delim) && s[i + 2] && s[i + 2] !== ' ') {
          const end = closing(s, i + 2, delim);
          if (end > 0) {
            out.push({ t, c: parseInline(s.slice(i + 2, end), depth + 1) });
            i = end + 2;
            matched = true;
            break;
          }
        }
      }
      if (matched) continue;
      if ((ch === '*' || ch === '_') && s[i + 1] && s[i + 1] !== ' ' && s[i + 1] !== ch) {
        // _ inside a word (snake_case) is not emphasis
        const wordBefore = ch === '_' && i > 0 && /[\p{L}\p{N}]/u.test(s[i - 1]);
        const end = wordBefore ? -1 : closing(s, i + 1, ch);
        if (end > 0 && !(ch === '_' && /[\p{L}\p{N}]/u.test(s[end + 1] ?? ''))) {
          out.push({ t: 'i', c: parseInline(s.slice(i + 1, end), depth + 1) });
          i = end + 1;
          continue;
        }
      }
    }
    // image ![alt](src) → alt text only
    const img = /^!\[([^\]]*)\]\(([^)\s]*)[^)]*\)/.exec(rest);
    if (img) {
      pushText(out, img[1]);
      i += img[0].length;
      continue;
    }
    // link [label](href)
    const link = /^\[([^\]]+)\]\(([^)\s]*)(?:\s+"[^"]*")?\)/.exec(rest);
    if (link) {
      const href = safeHref(link[2]);
      const label = parseInline(link[1], depth + 1);
      if (href) out.push({ t: 'a', href, c: label });
      else label.forEach((x) => (x.t === 'text' ? pushText(out, x.v) : out.push(x)));
      i += link[0].length;
      continue;
    }
    const bare = rest.startsWith('https://') ? BARE_URL.exec(rest) : null;
    if (bare && bare.index === 0) {
      const href = safeHref(bare[0]);
      if (href) {
        out.push({ t: 'a', href, c: [{ t: 'text', v: bare[0] }] });
        i += bare[0].length;
        continue;
      }
    }
    pushText(out, ch);
    i++;
  }
  return out;
}

/* ------------------------------------------------------------------ blocks */
export type ListItem = { c: Inline[]; sub?: { ordered: boolean; items: Inline[][] } };
export type Block =
  | { t: 'p'; lines: Inline[][] }
  | { t: 'h'; c: Inline[] }
  | { t: 'quote'; lines: Inline[][] }
  | { t: 'list'; ordered: boolean; start: number; items: ListItem[] };

const BULLET = /^(\s*)[-*+•]\s+(.*)$/;
const NUMBERED = /^(\s*)(\d{1,3})[.)]\s+(.*)$/;
const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const FENCE = /^\s{0,3}(```|~~~)/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;

export function parseMarkdown(src: string): Block[] {
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ t: 'p', lines: para.map((l) => parseInline(l.trim())) });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) {
      flush();
      continue;
    }
    if (FENCE.test(line)) {
      // Code blocks aren't supported: show the content as plain text lines.
      flush();
      const body: string[] = [];
      for (i++; i < lines.length && !FENCE.test(lines[i]); i++) body.push(lines[i]);
      if (body.some((l) => l.trim())) blocks.push({ t: 'p', lines: body.filter((l) => l.trim()).map((l) => [{ t: 'text', v: l.trim() }]) });
      continue;
    }
    if (RULE.test(line)) {
      flush();
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      flush();
      if (h[1]) blocks.push({ t: 'h', c: parseInline(h[1]) });
      continue;
    }
    if (QUOTE.test(line)) {
      flush();
      const q: string[] = [];
      for (; i < lines.length && QUOTE.test(lines[i]); i++) q.push(QUOTE.exec(lines[i])![1]);
      i--;
      blocks.push({ t: 'quote', lines: q.filter((l) => l.trim()).map((l) => parseInline(l.trim())) });
      continue;
    }
    const top = BULLET.exec(line) ?? NUMBERED.exec(line);
    if (top && top[1].length < 2) {
      flush();
      const ordered = !BULLET.test(line);
      const list: Extract<Block, { t: 'list' }> = { t: 'list', ordered, start: ordered ? Number(NUMBERED.exec(line)![2]) : 1, items: [] };
      for (; i < lines.length; i++) {
        const l = lines[i];
        if (!l.trim()) {
          // a blank line ends the list unless the next line continues it
          const next = lines[i + 1] ?? '';
          if ((BULLET.test(next) || NUMBERED.test(next)) && /^\s*/.exec(next)![0].length < 2 && (ordered ? NUMBERED.test(next) : BULLET.test(next))) continue;
          break;
        }
        const b = BULLET.exec(l);
        const n = NUMBERED.exec(l);
        const m = b ?? n;
        if (m && m[1].length >= 2 && list.items.length) {
          // one nesting level; deeper indentation is flattened into it
          const parent = list.items[list.items.length - 1];
          parent.sub ??= { ordered: !b, items: [] };
          parent.sub.items.push(parseInline((b ? b[2] : n![3]).trim()));
          continue;
        }
        if (m && (ordered ? !!n : !!b)) {
          list.items.push({ c: parseInline((b ? b[2] : n![3]).trim()) });
          continue;
        }
        if (m) break; // switches list type → new list
        if (/^\s{2,}\S/.test(l) && list.items.length) {
          // continuation line of the last item
          const last = list.items[list.items.length - 1];
          last.c = [...last.c, { t: 'br' }, ...parseInline(l.trim())];
          continue;
        }
        break;
      }
      i--;
      blocks.push(list);
      continue;
    }
    para.push(line);
  }
  flush();
  return blocks;
}

/* ------------------------------------------------------------------ render */
function renderInline(nodes: Inline[], key = 'i'): ReactNode[] {
  return nodes.map((n, k) => {
    const id = `${key}-${k}`;
    switch (n.t) {
      case 'text':
        return <Fragment key={id}>{n.v}</Fragment>;
      case 'br':
        return <br key={id} />;
      case 'b':
        return (
          <strong key={id} className="font-semibold text-ink">
            {renderInline(n.c, id)}
          </strong>
        );
      case 'i':
        return <em key={id}>{renderInline(n.c, id)}</em>;
      case 's':
        return <s key={id}>{renderInline(n.c, id)}</s>;
      case 'code':
        return (
          <code key={id} className="rounded bg-surface-2 border border-line px-1 py-px text-[0.9em] font-mono break-words">
            {n.v}
          </code>
        );
      case 'a':
        return (
          <a key={id} href={n.href} target="_blank" rel="noopener noreferrer" className="text-accent underline underline-offset-2 break-all hover:text-accent-strong">
            {renderInline(n.c, id)}
          </a>
        );
    }
  });
}

function lines(ls: Inline[][], key: string): ReactNode[] {
  return ls.flatMap((l, k) => (k === 0 ? renderInline(l, `${key}-${k}`) : [<br key={`${key}-br${k}`} />, ...renderInline(l, `${key}-${k}`)]));
}

/** Renders the safe Markdown subset. `className` goes on the wrapper (spacing between blocks is built in). */
export function Markdown({ text, className }: { text: string; className?: string }) {
  const blocks = parseMarkdown(text);
  return (
    <div className={['md space-y-2 break-words [overflow-wrap:anywhere]', className].filter(Boolean).join(' ')}>
      {blocks.map((b, k) => {
        const key = `b${k}`;
        switch (b.t) {
          case 'p':
            return <p key={key}>{lines(b.lines, key)}</p>;
          case 'h':
            return (
              <p key={key} className="font-semibold text-ink">
                {renderInline(b.c, key)}
              </p>
            );
          case 'quote':
            return (
              <blockquote key={key} className="border-l-2 border-accent/50 pl-3 text-muted">
                {lines(b.lines, key)}
              </blockquote>
            );
          case 'list': {
            const items = b.items.map((it, j) => (
              <li key={`${key}-${j}`}>
                {renderInline(it.c, `${key}-${j}`)}
                {it.sub &&
                  (it.sub.ordered ? (
                    <ol className="list-decimal pl-5 mt-1 space-y-0.5">
                      {it.sub.items.map((s, x) => (
                        <li key={x}>{renderInline(s, `${key}-${j}-${x}`)}</li>
                      ))}
                    </ol>
                  ) : (
                    <ul className="list-[circle] pl-5 mt-1 space-y-0.5">
                      {it.sub.items.map((s, x) => (
                        <li key={x}>{renderInline(s, `${key}-${j}-${x}`)}</li>
                      ))}
                    </ul>
                  ))}
              </li>
            ));
            return b.ordered ? (
              <ol key={key} start={b.start !== 1 ? b.start : undefined} className="list-decimal pl-5 space-y-1">
                {items}
              </ol>
            ) : (
              <ul key={key} className="list-disc pl-5 space-y-1">
                {items}
              </ul>
            );
          }
        }
      })}
    </div>
  );
}
