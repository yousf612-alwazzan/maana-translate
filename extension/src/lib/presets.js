// Provider presets and settings helpers. Shared by the service worker and the UI pages.

export const PRESETS = {
  gemini: {
    name: 'Google Gemini',
    kind: 'openai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keyUrl: 'https://aistudio.google.com/apikey',
    needsKey: true,
    free: true,
    model: 'gemini-4-hydrogen',
    visionModel: 'gemini-4-hydrogen',
    // Gemini 4 cannot switch thinking off; "minimal" is its lowest level.
    reasoning: () => 'minimal',
    boxStyle: 'yxyx',
    concurrency: 3,
    hint: 'المفتاح من Google AI Studio بحساب Google، وله حد استخدام يومي.',
  },
  groq: {
    name: 'Groq',
    kind: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    keyUrl: 'https://console.groq.com/keys',
    needsKey: true,
    free: true,
    model: 'llama-3.3-70b-versatile',
    visionModel: 'qwen/qwen3.8-27b',
    reasoning: (model) => (/qwen/i.test(model) ? 'none' : /gpt-oss/i.test(model) ? 'low' : ''),
    boxStyle: 'xyxy',
    concurrency: 1,
    hint: 'سريع جدًا، نماذج مفتوحة، وحدوده بالدقيقة صغيرة.',
  },
  openrouter: {
    name: 'OpenRouter',
    kind: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyUrl: 'https://openrouter.ai/settings/keys',
    needsKey: true,
    free: true,
    model: 'google/gemma-4-31b-it:free',
    visionModel: 'google/gemma-4-31b-it:free',
    reasoning: () => '',
    boxStyle: 'xyxy',
    concurrency: 2,
    hint: 'مفتاح واحد لعدة نماذج. النماذج اللي بدون رصيد ينتهي اسمها بـ ‎:free وحدها 50 طلب باليوم.',
  },
  ollama: {
    name: 'Ollama المحلي',
    kind: 'ollama',
    baseUrl: 'http://localhost:11434',
    keyUrl: '',
    needsKey: false,
    free: true,
    model: '',
    visionModel: '',
    reasoning: () => '',
    boxStyle: 'xyxy',
    concurrency: 1,
    numCtx: 8192,
    hint: 'يشتغل على جهازك بدون إنترنت. لازم Ollama يسمح للإضافة (شوف الملاحظة تحت).',
  },
  anthropic: {
    name: 'Claude',
    kind: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    needsKey: true,
    free: false,
    model: 'claude-opus-5-5',
    visionModel: 'claude-opus-5-5',
    reasoning: () => '',
    boxStyle: 'xyxy',
    concurrency: 3,
    hint: 'يحتاج رصيد API، وهو منفصل عن اشتراك تطبيق Claude.',
  },
  openai: {
    name: 'OpenAI',
    kind: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    keyUrl: 'https://platform.openai.com/api-keys',
    needsKey: true,
    free: false,
    model: '',
    visionModel: '',
    reasoning: () => '',
    boxStyle: 'xyxy',
    concurrency: 3,
    hint: 'يحتاج رصيد API، وهو منفصل عن اشتراك ChatGPT.',
  },
  custom: {
    name: 'مزود مخصص',
    kind: 'openai',
    baseUrl: '',
    keyUrl: '',
    needsKey: false,
    free: false,
    model: '',
    visionModel: '',
    reasoning: () => '',
    boxStyle: 'xyxy',
    concurrency: 2,
    hint: 'أي خدمة متوافقة مع صيغة OpenAI: حط الرابط والمفتاح واسم النموذج.',
  },
};

export const DEFAULT_ORDER = ['gemini', 'groq', 'openrouter', 'ollama', 'anthropic', 'openai', 'custom'];

// Arabic registers the user can pick (used only when translating into Arabic).
// Each one has a matching description for the model in prompts.js.
export const STYLES = {
  fusha: 'فصحى مبسطة',
  kuwaiti: 'كويتي',
  saudi: 'سعودي عام',
  najdi: 'سعودي نجدي',
  hijazi: 'سعودي حجازي',
  janoubi: 'سعودي جنوبي',
};

// Languages the user can translate INTO. The source can be any language.
//   own    letters of the language's own script, as a character class
//   notOwn letters that show the text is another language written in that script
//   must   letters that have to be present for the text to count as this language
// A page run is skipped as "already in the target language" only when most of
// its letters match `own` (and the other two tests agree). Languages that share
// a script with others have no `own`: the model is asked instead, and returns
// text that is already in the target language unchanged.
const ARABIC_SCRIPT = '\\u0600-\\u06FF\\u0750-\\u077F\\u08A0-\\u08FF\\uFB50-\\uFDFF\\uFE70-\\uFEFF';
export const LANGS = [
  // Persian and Urdu use the same script; their own letter forms mark text as not Arabic.
  { code: 'ar', name: 'العربية', en: 'Arabic', dir: 'rtl', own: `[${ARABIC_SCRIPT}]`, notOwn: '[\\u06A9\\u06CC\\u06D2\\u06C1\\u06BE\\u0679\\u0688\\u0691\\u06BA]' },
  { code: 'en', name: 'English', en: 'English', dir: 'ltr' },
  { code: 'fr', name: 'Français', en: 'French', dir: 'ltr' },
  { code: 'es', name: 'Español', en: 'Spanish', dir: 'ltr' },
  { code: 'de', name: 'Deutsch', en: 'German', dir: 'ltr' },
  { code: 'it', name: 'Italiano', en: 'Italian', dir: 'ltr' },
  { code: 'pt', name: 'Português', en: 'Portuguese', dir: 'ltr' },
  { code: 'tr', name: 'Türkçe', en: 'Turkish', dir: 'ltr' },
  { code: 'ru', name: 'Русский', en: 'Russian', dir: 'ltr' },
  { code: 'uk', name: 'Українська', en: 'Ukrainian', dir: 'ltr' },
  { code: 'fa', name: 'فارسی', en: 'Persian', dir: 'rtl' },
  { code: 'ur', name: 'اردو', en: 'Urdu', dir: 'rtl' },
  { code: 'he', name: 'עברית', en: 'Hebrew', dir: 'rtl', own: '[\\u0590-\\u05FF]' },
  { code: 'hi', name: 'हिन्दी', en: 'Hindi', dir: 'ltr', own: '[\\u0900-\\u097F]' },
  { code: 'bn', name: 'বাংলা', en: 'Bengali', dir: 'ltr', own: '[\\u0980-\\u09FF]' },
  { code: 'id', name: 'Bahasa Indonesia', en: 'Indonesian', dir: 'ltr' },
  { code: 'ms', name: 'Bahasa Melayu', en: 'Malay', dir: 'ltr' },
  { code: 'fil', name: 'Filipino', en: 'Filipino', dir: 'ltr' },
  { code: 'vi', name: 'Tiếng Việt', en: 'Vietnamese', dir: 'ltr' },
  { code: 'th', name: 'ไทย', en: 'Thai', dir: 'ltr', own: '[\\u0E00-\\u0E7F]' },
  { code: 'ja', name: '日本語', en: 'Japanese', dir: 'ltr', own: '[\\u3040-\\u30FF\\u4E00-\\u9FFF]', must: '[\\u3040-\\u30FF]' },
  { code: 'ko', name: '한국어', en: 'Korean', dir: 'ltr', own: '[\\uAC00-\\uD7AF\\u1100-\\u11FF]' },
  { code: 'zh', name: '简体中文', en: 'Simplified Chinese', dir: 'ltr', own: '[\\u4E00-\\u9FFF]', notOwn: '[\\u3040-\\u30FF\\uAC00-\\uD7AF]' },
  { code: 'zh-TW', name: '繁體中文', en: 'Traditional Chinese', dir: 'ltr' },
  { code: 'el', name: 'Ελληνικά', en: 'Greek', dir: 'ltr', own: '[\\u0370-\\u03FF]' },
  { code: 'nl', name: 'Nederlands', en: 'Dutch', dir: 'ltr' },
  { code: 'pl', name: 'Polski', en: 'Polish', dir: 'ltr' },
  { code: 'sv', name: 'Svenska', en: 'Swedish', dir: 'ltr' },
  { code: 'ro', name: 'Română', en: 'Romanian', dir: 'ltr' },
  { code: 'cs', name: 'Čeština', en: 'Czech', dir: 'ltr' },
  { code: 'hu', name: 'Magyar', en: 'Hungarian', dir: 'ltr' },
];

// The target language as plain data (it travels in messages to the content scripts).
// "other" is a language the user typed by name; its direction is left to the page.
export function langInfo(settings) {
  if (settings.targetLang === 'other') {
    const name = (settings.targetOther || '').trim().slice(0, 40);
    if (name) return { code: 'other', key: 'other:' + name.toLowerCase(), en: name, name, dir: null, own: null, notOwn: null, must: null };
  }
  const l = LANGS.find((x) => x.code === settings.targetLang) || LANGS[0];
  return { code: l.code, key: l.code, en: l.en, name: l.name, dir: l.dir, own: l.own || null, notOwn: l.notOwn || null, must: l.must || null };
}

export function defaultSettings() {
  const providers = {};
  for (const id of DEFAULT_ORDER) {
    providers[id] = { enabled: id === 'gemini', apiKey: '', model: '', visionModel: '', baseUrl: '' };
  }
  return {
    order: [...DEFAULT_ORDER],
    providers,
    targetLang: 'ar', // a code from LANGS, or 'other' with the name in targetOther
    targetOther: '',
    style: 'fusha', // Arabic register; only used when the target is Arabic
    extra: '',
    lowThinking: true,
    autoSites: {},
    manga: { minSize: 260, sfx: true },
    // The user has agreed that content they ask to translate is sent to their provider.
    consent: false,
  };
}

// Fill in anything missing so older or partial saved settings keep working.
export function mergeSettings(raw) {
  const d = defaultSettings();
  if (!raw || typeof raw !== 'object') return d;
  const out = { ...d, ...raw };
  out.providers = { ...d.providers };
  for (const id of DEFAULT_ORDER) out.providers[id] = { ...d.providers[id], ...(raw.providers?.[id] || {}) };
  const known = (Array.isArray(raw.order) ? raw.order : []).filter((id) => PRESETS[id]);
  out.order = [...known, ...DEFAULT_ORDER.filter((id) => !known.includes(id))];
  out.manga = { ...d.manga, ...(raw.manga || {}) };
  out.autoSites = raw.autoSites && typeof raw.autoSites === 'object' ? raw.autoSites : {};
  if (!STYLES[out.style]) out.style = 'fusha';
  if (out.targetLang !== 'other' && !LANGS.some((l) => l.code === out.targetLang)) out.targetLang = 'ar';
  out.targetOther = typeof raw.targetOther === 'string' ? raw.targetOther : '';
  out.consent = raw.consent === true;
  return out;
}

// Content only leaves the browser over HTTPS; plain HTTP is accepted for a
// provider running on this same computer (Ollama and the like).
export function isSecureUrl(value) {
  try {
    const u = new URL(value);
    if (u.protocol === 'https:') return true;
    return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  } catch {
    return false;
  }
}

// Combine a preset with the user's saved values into one ready-to-call provider.
export function resolveProvider(id, settings, draft) {
  const preset = PRESETS[id];
  if (!preset) return null;
  const saved = { ...(settings.providers?.[id] || {}), ...(draft || {}) };
  const model = (saved.model || preset.model || '').trim();
  const visionModel = (saved.visionModel || preset.visionModel || model).trim();
  return {
    id,
    name: preset.name,
    kind: preset.kind,
    enabled: !!saved.enabled,
    needsKey: preset.needsKey,
    baseUrl: (saved.baseUrl || preset.baseUrl || '').trim().replace(/\/+$/, ''),
    apiKey: (saved.apiKey || '').trim(),
    model,
    visionModel,
    boxStyle: preset.boxStyle,
    concurrency: preset.concurrency,
    minGapMs: preset.minGapMs || 0,
    batch: preset.batch || null,
    numCtx: preset.numCtx,
    reasoningFor: preset.reasoning,
  };
}

// How the page should cut its text into requests for the provider that will be
// tried first: services with tight request limits want fewer, larger batches.
export function batchHint(settings) {
  for (const id of settings.order) {
    const p = resolveProvider(id, settings);
    if (isUsable(p)) return p.batch || { first: 1500, next: 3600, parallel: 3 };
  }
  return { first: 1500, next: 3600, parallel: 3 };
}

export function isUsable(p) {
  return !!p && p.enabled && isSecureUrl(p.baseUrl) && !!p.model && (!p.needsKey || !!p.apiKey);
}
