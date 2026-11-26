import { describe, expect, it } from 'vitest';
import { requestedReplyLang, resolveReplyLang, replyLangSource } from '../../supabase/functions/_shared/ai/replyLanguage';

describe('negated reply-language requests never select the refused language', () => {
  it('ignores negated Icelandic requests', () => {
    expect(requestedReplyLang('Ekki svara á ensku')).toBeNull();
    expect(requestedReplyLang('Ekki svara mér á ensku')).toBeNull();
    expect(requestedReplyLang('ekki á íslensku takk')).toBeNull();
    expect(requestedReplyLang('Aldrei skrifa á ensku')).toBeNull();
    expect(resolveReplyLang({ text: 'Ekki svara á ensku', setting: 'en' })).not.toBe('en');
    expect(resolveReplyLang({ text: 'Ekki svara á ensku', setting: 'is' })).toBe('is');
  });

  it('ignores negated English requests', () => {
    expect(requestedReplyLang("Don't answer in Icelandic")).toBeNull();
    expect(requestedReplyLang('don’t reply in English')).toBeNull();
    expect(requestedReplyLang('Please do not reply to me in English')).toBeNull();
    expect(requestedReplyLang('not in English please')).toBeNull();
    expect(requestedReplyLang('never answer in icelandic')).toBeNull();
    expect(resolveReplyLang({ text: "Don't answer in Icelandic", setting: 'is' })).not.toBe('is');
    expect(replyLangSource({ text: "Don't answer in Icelandic", setting: 'is' })).not.toBe('asked');
  });

  it('still honours plain and mixed requests', () => {
    expect(requestedReplyLang('No, answer in English')).toBe('en');
    expect(requestedReplyLang('Svaraðu á ensku')).toBe('en');
    expect(requestedReplyLang('Please answer in Icelandic')).toBe('is');
    expect(requestedReplyLang("Don't answer in English, answer in Icelandic")).toBe('is');
    expect(requestedReplyLang('Ekki svara á íslensku, svaraðu á ensku')).toBe('en');
    expect(requestedReplyLang('Svaraðu á ensku. Ekki á íslensku takk')).toBe('en');
  });
});
