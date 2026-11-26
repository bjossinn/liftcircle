import { describe, expect, it } from 'vitest';
import { refusedReplyLang, replyLanguageLine, requestedReplyLang, resolveReplyLang, replyLangSource } from '../../supabase/functions/_shared/ai/replyLanguage';

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

  it('politeness words and punctuation around a negated request never select the refused language', () => {
    const IS_NEG = ['Ekki svara á ensku takk', 'Ekki svara á ensku takk fyrir', 'Ekki svara á ensku, takk.', 'Vinsamlegast ekki svara á ensku', 'Endilega ekki svara á ensku!',
      'Ekki vinsamlegast svara á ensku', 'ekki á ensku takk', 'Takk, en ekki svara mér á ensku takk.', '(Ekki svara á ensku takk)'];
    for (const msg of IS_NEG) {
      expect(requestedReplyLang(msg), msg).toBeNull();
      expect(resolveReplyLang({ text: msg, setting: 'is' }), msg).toBe('is');
      expect(replyLangSource({ text: msg, setting: 'is' }), msg).not.toBe('asked');
    }
    expect(requestedReplyLang('Ekki svara á íslensku takk')).toBeNull();
    const EN_NEG = ["Don't reply in English please", "Don't reply in English, please.", 'Please don’t reply in English, thanks', "Don't reply in English thank you",
      'Kindly do not answer in English please', "Don't please reply in English", 'Do not reply in English pls', 'Thanks! Never answer in English please.', 'No English please'];
    for (const msg of EN_NEG) {
      expect(requestedReplyLang(msg), msg).toBeNull();
      expect(refusedReplyLang(msg), msg).toBe('en');
      // Written in English, but English was refused: never English, whatever the app language.
      expect(resolveReplyLang({ text: msg, setting: 'is' }), msg).toBe('is');
      expect(resolveReplyLang({ text: msg, setting: 'en' }), msg).toBe('is');
      expect(replyLangSource({ text: msg, setting: 'en' }), msg).toBe('refused');
    }
    expect(replyLanguageLine('is', 'refused')).toBe('Reply language: Icelandic (the user asked not to be answered in English).');
    expect(requestedReplyLang("Don't answer in Icelandic please")).toBeNull();
    expect(resolveReplyLang({ text: "Don't answer in Icelandic please", setting: 'is' })).toBe('en');
    // A later, un-negated request still wins; and polite requests are still requests.
    expect(requestedReplyLang('Ekki svara á ensku takk, svaraðu á íslensku')).toBe('is');
    expect(requestedReplyLang("Don't reply in English please, answer in Icelandic")).toBe('is');
    expect(requestedReplyLang('Svaraðu á ensku takk')).toBe('en');
    expect(requestedReplyLang('Reply in English please')).toBe('en');
    expect(requestedReplyLang('Á íslensku takk')).toBe('is');
    expect(requestedReplyLang('No, answer in English please')).toBe('en');
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
