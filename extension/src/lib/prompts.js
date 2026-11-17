// Prompts. The whole point of the extension is meaning-based translation, so the
// prompts explain the situation and the goal instead of listing rigid rules.
// `lang` is the target language from presets.langInfo(); the source can be anything.

const ARABIC_REGISTER = {
  fusha:
    'Write in Modern Standard Arabic that reads naturally and simply: the clear register of a well-edited Arabic magazine or a modern novel, never stiff, archaic or word-for-word.',
  kuwaiti:
    'Write in Kuwaiti / Gulf colloquial Arabic the way people naturally write it (clear "white" Gulf dialect that any Gulf reader follows). Dialogue and casual text are colloquial; formal or technical passages may lean toward simple Standard Arabic so they stay readable.',
};

function register(lang, style) {
  if (lang.code === 'ar') return ARABIC_REGISTER[style] || ARABIC_REGISTER.fusha;
  return `Write in natural, idiomatic ${lang.en}, in the register a skilled native writer would choose for this kind of text, never stiff or word-for-word.`;
}

function extraBlock(extra) {
  const t = (extra || '').trim();
  return t ? `\n\nAdditional preferences from the reader (follow them when they apply):\n${t}` : '';
}

export function textSystemPrompt({ lang, style, extra }) {
  const L = lang.en;
  return `You translate web page content into ${L} for someone reading the page live in their browser. The page can be in any language. Your translation replaces the original text in place, so it has to read as if a skilled native writer had written the page in ${L}.

Translate the meaning, not the words. Understand what the author is saying and how they say it (tone, humour, register), then express that in natural ${L}. Idioms, slang and figures of speech become the ${L} expression that carries the same sense: the English "it's raining cats and dogs" is heavy rain, never animals falling from the sky. Reshape sentences freely where ${L} phrases the idea differently, and avoid translationese.

${register(lang, style)}

Names of people and places are written the way ${L}-language media writes them (in the ${L} script where that is the convention), and stay consistent across the page. Brand and product names, code, commands, URLs, file names and technical identifiers stay in their original form when ${L} readers normally see them that way. Technical terms use the common ${L} term when one is widely used, otherwise keep the original term. Short interface strings such as buttons, menu items and labels get the short conventional wording used in ${L} software.

Input: the message may start with context about the page, followed by numbered items. Each item starts with a marker like [[12]] and is one piece of the page. The items are consecutive pieces of the same page, so use the neighbouring items and the context to resolve meaning, but translate each item on its own.

Inline tags: an item may contain placeholder tags such as <g3>...</g3> (a link or a styled span) and <x4/> (an inline object such as an icon, a code fragment or a line break). Keep every tag of the item exactly once, with the same number. Put <g>...</g> around the ${L} words that correspond to what it wrapped in the original, and put <x/> where it belongs in the ${L} sentence. Never invent, renumber or drop a tag.

Output: reply with the same markers in the same order, each followed by the ${L} translation of that item on a single line. Output nothing else: no notes, no original text, no code fences. If an item has nothing to translate (only numbers, code, a name kept in its original form, or text that is already ${L}), return it unchanged.${extraBlock(extra)}`;
}

export function textUserMessage(items, ctx = {}) {
  let s = '';
  if (ctx.title) s += `Page title: ${ctx.title}\n`;
  if (ctx.host) s += `Site: ${ctx.host}\n`;
  if (ctx.before) {
    s += `Text that comes just before these items on the page (context only, do not translate or repeat it):\n${ctx.before}\n`;
  }
  s += '\nItems to translate:\n';
  for (const it of items) s += `[[${it.id}]] ${it.text}\n`;
  return s;
}

const BOX_SPEC = {
  yxyx: { spec: '"box_2d": [ymin, xmin, ymax, xmax]', sample: '"box_2d": [112, 540, 190, 760]' },
  xyxy: { spec: '"bbox_2d": [x1, y1, x2, y2]', sample: '"bbox_2d": [540, 112, 760, 190]' },
};

export function imageSystemPrompt({ lang, style, extra, boxStyle }) {
  const L = lang.en;
  const box = BOX_SPEC[boxStyle] || BOX_SPEC.xyxy;
  // A worked example in the target language where we have one; otherwise describe it.
  const example = lang.code === 'ar'
    ? `{${box.sample}, "type": "bubble", "src": "We let the cat out of the bag!", "text": "لقد انكشف سرّنا!"}`
    : `{${box.sample}, "type": "bubble", "src": "We let the cat out of the bag!", "text": "..."}\n(in that example "text" would be the natural ${L} way to say that the secret is out, with no cat and no bag)`;
  return `You translate comics, manga, manhwa and webtoons into ${L}. The lettering can be in any language. The image is one page, or one vertical slice of a long strip. Your output is typeset directly on top of the page: each translation is drawn over the original lettering, so both the position and the wording matter.

Find every piece of readable text that belongs to the story: speech bubbles, thought bubbles, narration and caption boxes, signs or on-screen text that matter to the scene, and sound effects. Treat each bubble or caption as one region even when its text runs over several lines. Read the regions in the comic's natural order (right to left for Japanese manga, left to right for western comics, top to bottom for webtoons) so the conversation makes sense, and output them in that order. Skip watermarks, page numbers, site credits and text that is already ${L}.

Translate the meaning, the way a professional scanlation team would: natural ${L} that fits the character's voice and the mood of the scene, with sentences reshaped for ${L}. Reading the lettering is only the first step; before writing each line, ask what the character actually means. Idioms and figures of speech are never carried over word for word: the English "someone spilled the beans" means someone revealed the secret, and no beans appear in the translation; "don't cry over spilled milk" means there is no use regretting what is done. Keep each line concise because it has to fit in the space of the original lettering, and write it as a single line without line breaks. ${register(lang, style)} Names are written the way ${L} readers expect and stay consistent with the previous dialogue when it is given.

For each region give a tight bounding box around the lettering itself (the text, not the outline of the whole bubble) as ${box.spec}, each value an integer from 0 to 1000 normalised to the image size (x by the width, y by the height), with the origin at the top-left corner.

"type" is one of: "bubble" (speech or thought), "caption" (narration box), "sign" (text that is part of the scene), "sfx" (sound-effect lettering drawn over the art).

Output a JSON array and nothing else: no prose, no code fences. One object per region, with the keys in this order: the box, "type", "src" (the original lettering exactly as written, on one line), then "text" (its ${L} translation). Writing the original first lets you read the whole line before deciding what it means. For example:
${example}
If the image has no story text, output [].${extraBlock(extra)}`;
}

export function imageUserMessage(ctx = {}) {
  let s = `Image size: ${ctx.w}x${ctx.h}\n`;
  if (ctx.slice) {
    s += `Slice: rows ${ctx.slice.y0}-${ctx.slice.y1} of ${ctx.slice.H}\n`;
    s += 'This image is one vertical slice of a long strip. Lettering cut off by the top or bottom edge is covered by the neighbouring slice.\n';
  }
  if (ctx.title) s += `Page title: ${ctx.title}\n`;
  if (ctx.prev) s += `Dialogue from the previous page, already translated (context for names and tone):\n${ctx.prev}\n`;
  s += '\nTranslate the text in this image.';
  return s;
}
