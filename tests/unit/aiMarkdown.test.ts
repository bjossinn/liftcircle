/**
 * Safe Markdown subset for training assistant messages (src/features/coaching/ai/markdown.tsx): formatting, headings as bold
 * lines, lists with one nesting level, inline code, https-only links, and XSS inputs rendering inert.
 */
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Markdown, parseMarkdown, safeHref } from '@/features/coaching/ai/markdown';

const html = (text: string) => renderToStaticMarkup(createElement(Markdown, { text }));

describe('AI message Markdown', () => {
  it('bold, italic, strike and inline code', () => {
    const out = html('Do **3 × 8** at *RIR 2*, ~~not 5~~ — use `barbell-squat`.');
    expect(out).toContain('<strong class="font-semibold text-ink">3 × 8</strong>');
    expect(out).toContain('<em>RIR 2</em>');
    expect(out).toContain('<s>not 5</s>');
    expect(out).toMatch(/<code[^>]*>barbell-squat<\/code>/);
  });

  it('paragraphs and single line breaks', () => {
    const out = html('First line\nsecond line\n\nNew paragraph');
    expect(out).toMatch(/<p>First line<br\/>second line<\/p><p>New paragraph<\/p>/);
  });

  it('bulleted and numbered lists, with one nesting level', () => {
    const out = html('- **Mon** Upper A\n- Wed Lower A\n  - squats first\n  - then RDLs\n\n1. Warm up\n2. Work sets');
    expect(out).toMatch(/<ul class="list-disc[^"]*"><li><strong[^>]*>Mon<\/strong> Upper A<\/li><li>Wed Lower A<ul[^>]*><li>squats first<\/li><li>then RDLs<\/li><\/ul><\/li><\/ul>/);
    expect(out).toMatch(/<ol class="list-decimal[^"]*"><li>Warm up<\/li><li>Work sets<\/li><\/ol>/);
  });

  it('headings are shown as a bold line, blockquotes get a left border', () => {
    const out = html('## Your week\n> Rest is training too');
    expect(out).toContain('<p class="font-semibold text-ink">Your week</p>');
    expect(out).not.toMatch(/<h\d/);
    expect(out).toMatch(/<blockquote class="border-l-2[^"]*">Rest is training too<\/blockquote>/);
  });

  it('https links open in a new tab with noopener noreferrer; bare https URLs too', () => {
    const out = html('See [the guide](https://example.com/a?b=1) or https://example.org/x.');
    expect(out).toContain('<a href="https://example.com/a?b=1" target="_blank" rel="noopener noreferrer"');
    expect(out).toContain('href="https://example.org/x"');
    expect(out).toMatch(/example\.org\/x<\/a>\.<\/p>/);
  });

  it('XSS inputs render inert: script, img onerror, raw HTML, javascript:/data:/http: links', () => {
    const out = html(
      '<script>alert(1)</script>\n<img src=x onerror="alert(2)">\n[click](javascript:alert(3)) [d](data:text/html,<b>x</b>) [h](http://example.com) ![pic](https://evil.example/x.png)\n<a href="https://x.example" onclick="y()">a</a>',
    );
    expect(out).not.toMatch(/<script|<img|<a [^>]*onclick|onerror="|href="javascript:|href="data:|href="http:/i);
    expect(out).toContain('&lt;script&gt;alert(1)&lt;/script&gt;'); // shown literally as text
    expect(out).toContain('click'); // non-https link keeps only its label
    expect(out).toContain('pic'); // image → alt text
    expect(safeHref('javascript:alert(1)')).toBeNull();
    expect(safeHref('JaVaScRiPt:alert(1)')).toBeNull();
    expect(safeHref('https://ok.example/path')).toBe('https://ok.example/path');
  });

  it('tables and code blocks are plain text (no <table>/<pre>)', () => {
    const out = html('| a | b |\n|---|---|\n| 1 | 2 |\n\n```js\nconsole.log(1)\n```');
    expect(out).not.toMatch(/<table|<pre/);
    expect(out).toContain('| a | b |');
    expect(out).toContain('console.log(1)');
    expect(out).not.toContain('```');
  });

  it('long words and URLs wrap (break-words / overflow-wrap:anywhere / break-all on links)', () => {
    const long = `https://example.com/${'a'.repeat(300)}`;
    const out = html(`Look: ${long} and ${'x'.repeat(200)}`);
    expect(out).toMatch(/class="md [^"]*break-words[^"]*\[overflow-wrap:anywhere\]/);
    expect(out).toMatch(/<a [^>]*class="[^"]*break-all/);
  });

  it('snake_case and lone markers stay literal', () => {
    expect(html('use snake_case_name and 2 * 3 * 4')).toContain('use snake_case_name and 2 * 3 * 4');
    expect(parseMarkdown('**unclosed bold')).toEqual([{ t: 'p', lines: [[{ t: 'text', v: '**unclosed bold' }]] }]);
  });
});
