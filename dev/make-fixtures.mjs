// Generates dev/fixtures/{page1.png,strip.png,comic.json,page.html,idioms.html,comic.html,comic-ref.html}
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { FIX, chromiumExe } from './common.mjs';

fs.mkdirSync(FIX, { recursive: true });

const FONT = `'Comic Sans MS','Comic Neue','Chalkboard SE',cursive`;

/* ------------------------------------------------------------------ */
/* Comic specs. kind: ell | rect | dark | cap | sfx | sign              */
/* ------------------------------------------------------------------ */
const page1 = {
  w: 1000, h: 1500,
  panels: [
    { x: 30, y: 30, w: 940, h: 400, bg: 'linear-gradient(#7ec0ee,#e6f4ff)' },
    { x: 30, y: 460, w: 455, h: 440, bg: 'repeating-linear-gradient(45deg,#ecc98a 0 6px,#d9a94f 6px 9px)' },
    { x: 515, y: 460, w: 455, h: 440, bg: '#a5d8b8' },
    { x: 30, y: 930, w: 940, h: 290, bg: 'linear-gradient(90deg,#f6a65e,#e8708f)' },
    { x: 30, y: 1250, w: 940, h: 220, bg: 'radial-gradient(circle,#9aa6ff 2.5px,transparent 3.5px) 0 0/16px 16px,#eef0ff' },
  ],
  figures: [ // head centre x,y ; scale
    { x: 230, y: 320, c: '#c0392b' }, { x: 760, y: 320, c: '#1f6fb2' },
    { x: 120, y: 700, c: '#c0392b' }, { x: 390, y: 780, c: '#1f6fb2' }, { x: 735, y: 700, c: '#1f6fb2' },
    { x: 260, y: 1120, c: '#c0392b', s: 0.8 }, { x: 760, y: 1120, c: '#1f6fb2', s: 0.8 },
  ],
  items: [
    { type: 'caption', kind: 'cap', x: 50, y: 48, w: 420, h: 60, fs: 22, text: 'Saturday morning. Bake sale day.', ar: 'صباح السبت. يوم بيع الكعك.' },
    { type: 'bubble', kind: 'ell', x: 70, y: 125, w: 390, h: 150, fs: 26, tail: [215, 300], text: "Don't worry, it'll be a piece of cake!", ar: 'لا تقلق، الأمر في غاية السهولة!' },
    { type: 'bubble', kind: 'ell', x: 550, y: 110, w: 390, h: 160, fs: 26, tail: [745, 300], text: 'You said that last week, and we burned everything!', ar: 'قلت ذلك الأسبوع الماضي واحترق كل شيء!' },
    { type: 'bubble', kind: 'rect', x: 55, y: 485, w: 340, h: 125, fs: 26, tail: [110, 676], text: "Let's hit the sack early tonight.", ar: 'لننم باكرا هذه الليلة.' },
    { type: 'bubble', kind: 'ell', x: 540, y: 488, w: 400, h: 150, fs: 26, tail: [735, 676], text: "I'm so nervous, I could never sleep!", ar: 'أنا متوتر جدا، لن أستطيع النوم أبدا!' },
    { type: 'bubble', kind: 'ell', x: 175, y: 628, w: 300, h: 120, fs: 22, tail: [395, 758], text: "That's easier said than done.", ar: 'هذا أسهل قولا من فعل.' },
    { type: 'bubble', kind: 'dark', x: 55, y: 950, w: 430, h: 150, fs: 24, tail: [250, 1090], text: 'Somebody spilled the beans about our secret recipe...', ar: 'أحدهم أفشى سر وصفتنا...' },
    { type: 'bubble', kind: 'ell', x: 540, y: 948, w: 410, h: 140, fs: 26, tail: [750, 1090], text: "Great. Now it's raining cats and dogs too!", ar: 'رائع. والآن تمطر بغزارة أيضا!' },
    { type: 'bubble', kind: 'rect', x: 55, y: 1272, w: 440, h: 120, fs: 26, tail: [440, 1440], text: "Let's not cry over spilled milk. Open the stall!", ar: 'لا داعي للبكاء على اللبن المسكوب. افتح الكشك!' },
    { type: 'sfx', kind: 'sfx', x: 600, y: 1300, w: 340, h: 130, fs: 104, color: '#ff5a1f', text: 'CRASH!', ar: 'طاخ!' },
  ],
};

const stripPanels = [[20, 540], [570, 1000], [1030, 1450], [1480, 2000], [2030, 2480], [2510, 3050], [3080, 3700], [3730, 4300], [4330, 4900], [4930, 5450], [5480, 5980]];
const stripBgs = [
  'linear-gradient(#7ec0ee,#e6f4ff)', 'repeating-linear-gradient(45deg,#ecc98a 0 6px,#d9a94f 6px 9px)', '#a5d8b8',
  'linear-gradient(90deg,#f6a65e,#e8708f)', 'radial-gradient(circle,#9aa6ff 2.5px,transparent 3.5px) 0 0/16px 16px,#eef0ff', '#f1d6a0',
  'repeating-linear-gradient(-45deg,#b8d8f0 0 7px,#9cc3e0 7px 10px)', 'linear-gradient(#2b2d5e,#5b4a8f)', '#cfe8c4',
  'radial-gradient(circle,#f0a0a0 2.5px,transparent 3.5px) 0 0/16px 16px,#fff1ee', 'linear-gradient(#ffd68a,#f58f6a)',
];
const strip = {
  w: 800, h: 6000,
  panels: stripPanels.map(([a, b], i) => ({ x: 20, y: a, w: 760, h: b - a, bg: stripBgs[i] })),
  figures: stripPanels.map(([a, b], i) => ({ x: i % 2 ? 620 : 180, y: b - 120, c: ['#c0392b', '#1f6fb2', '#2a8c5a'][i % 3], s: 0.85 })),
  items: [
    { type: 'caption', kind: 'cap', x: 40, y: 45, w: 400, h: 70, fs: 22, text: 'Later that day, at the bake sale stall.', ar: 'في وقت لاحق من ذلك اليوم، عند كشك بيع الكعك.' },
    { type: 'bubble', kind: 'ell', x: 60, y: 170, w: 400, h: 150, fs: 26, tail: [200, 400], text: 'Is anyone actually coming, or are we wasting our time?', ar: 'هل سيأتي أحد فعلا أم أننا نضيع وقتنا؟' },
    { type: 'bubble', kind: 'ell', x: 400, y: 345, w: 360, h: 130, fs: 26, tail: [600, 420], text: "Hold your horses. It's still early.", ar: 'تمهل قليلا. ما زال الوقت مبكرا.' },
    { type: 'sign', kind: 'sign', x: 120, y: 620, w: 420, h: 110, fs: 30, text: 'BAKE SALE - TODAY ONLY', ar: 'بيع الكعك - اليوم فقط' },
    { type: 'bubble', kind: 'ell', x: 380, y: 780, w: 370, h: 130, fs: 26, tail: [560, 880], text: 'Look, a customer is heading our way!', ar: 'انظر، زبون يتجه نحونا!' },
    { type: 'bubble', kind: 'ell', x: 400, y: 1090, w: 360, h: 120, fs: 26, tail: [600, 1260], text: "Quick, act natural. Don't scare them off!", ar: 'بسرعة، تصرف بشكل طبيعي. لا تخيفه!' },
    { type: 'bubble', kind: 'rect', x: 50, y: 1290, w: 380, h: 110, fs: 25, tail: [180, 1330], text: "I'm so nervous, I'm walking on eggshells.", ar: 'أنا متوتر جدا، أمشي على قشر البيض.' },
    { type: 'bubble', kind: 'ell', x: 60, y: 1560, w: 400, h: 130, fs: 26, tail: [180, 1700], text: 'Welcome! Everything is half price today. A real steal!', ar: 'أهلا بك! كل شيء بنصف السعر اليوم. صفقة رابحة!' },
    { type: 'bubble', kind: 'dark', x: 330, y: 1770, w: 420, h: 150, fs: 24, tail: [560, 1900], text: 'The customer eyed the last cake with a hungry look...', ar: 'حدق الزبون في آخر كعكة بنظرة جائعة...' },
    { type: 'sfx', kind: 'sfx', x: 80, y: 2090, w: 330, h: 120, fs: 96, color: '#ff3d6e', text: 'MUNCH!', ar: 'قضم!' },
    { type: 'bubble', kind: 'ell', x: 400, y: 2190, w: 360, h: 120, fs: 26, tail: [600, 2350], text: "That was the best cake I've ever had!", ar: 'كانت أفضل كعكة تذوقتها في حياتي!' },
    { type: 'bubble', kind: 'ell', x: 60, y: 2600, w: 390, h: 140, fs: 26, tail: [180, 2800], text: 'See? I told you it would be a piece of cake.', ar: 'ألم أقل لك؟ قلت لك إن الأمر سهل جدا.' },
    { type: 'bubble', kind: 'rect', x: 380, y: 3180, w: 370, h: 120, fs: 26, tail: [600, 3400], text: "We sold out in an hour. Let's call it a day.", ar: 'بعنا كل شيء في ساعة. لننه يومنا.' },
    { type: 'bubble', kind: 'ell', x: 60, y: 3480, w: 380, h: 130, fs: 26, tail: [180, 3600], text: "I'm exhausted. I'm going to hit the sack.", ar: 'أنا منهك. سأذهب إلى النوم.' },
    { type: 'bubble', kind: 'ell', x: 380, y: 4010, w: 370, h: 130, fs: 26, tail: [620, 4170], text: 'Sleep tight. Tomorrow we bake twice as much!', ar: 'نم جيدا. غدا سنخبز ضعف الكمية!' },
  ],
};
// ordering by y to be safe
strip.items.sort((a, b) => a.y - b.y);

/* ------------------------------------------------------------------ */
function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;'); }

function stick(f) {
  const s = f.s || 1, x = f.x, y = f.y, c = f.c;
  const r = 20 * s, sh = y + r, hip = sh + 52 * s, foot = hip + 46 * s;
  return `<g stroke="${c}" stroke-width="${5 * s}" stroke-linecap="round" fill="none">
    <circle cx="${x}" cy="${y}" r="${r}" fill="#fff6e0" stroke="#222" stroke-width="${3 * s}"/>
    <path d="M${x} ${sh} L${x} ${hip} M${x} ${sh + 12 * s} L${x - 30 * s} ${sh + 38 * s} M${x} ${sh + 12 * s} L${x + 30 * s} ${sh + 38 * s} M${x} ${hip} L${x - 24 * s} ${foot} M${x} ${hip} L${x + 24 * s} ${foot}"/></g>`;
}

function tailPoly(it, inset) {
  const [tx, ty] = it.tail;
  const cx = it.x + it.w / 2;
  const down = ty > it.y + it.h / 2;
  const by = down ? it.y + it.h - 10 : it.y + 10;
  const bx = Math.max(it.x + 40, Math.min(it.x + it.w - 40, cx + (tx - cx) * 0.35));
  const half = inset ? 13 : 20;
  const ex = inset ? tx - (tx - bx) * 0.06 : tx, ey = inset ? ty - (ty - by) * 0.06 : ty;
  return `${bx - half},${by} ${bx + half},${by} ${ex},${ey}`;
}

function comicHTML(spec) {
  const { w, h } = spec;
  let panels = '', fig = '', tailsU = '', tailsO = '', els = '', txt = '';
  for (const p of spec.panels) panels += `<div style="position:absolute;left:${p.x}px;top:${p.y}px;width:${p.w}px;height:${p.h}px;background:${p.bg};border:5px solid #111;box-sizing:border-box"></div>`;
  for (const f of spec.figures) fig += stick(f);
  spec.items.forEach((it, i) => {
    const pos = `left:${it.x}px;top:${it.y}px;width:${it.w}px;height:${it.h}px;`;
    const t = `<p class="t" data-i="${i}" style="font-size:${it.fs}px">${esc(it.text)}</p>`;
    const tx = (extra) => `<div class="bub" style="${pos}${extra}">${t}</div>`;
    if (it.kind === 'ell' || it.kind === 'rect' || it.kind === 'dark') {
      const dark = it.kind === 'dark';
      const fill = dark ? '#16162a' : '#fff', stroke = dark ? '#fff' : '#111';
      if (it.tail) {
        tailsU += `<polygon points="${tailPoly(it, false)}" fill="${fill}" stroke="${stroke}" stroke-width="3.5" stroke-linejoin="round"/>`;
        tailsO += `<polygon points="${tailPoly(it, true)}" fill="${fill}"/>`;
      }
      const rad = it.kind === 'rect' ? '30px' : '50%';
      const pad = it.kind === 'rect' ? '0 22px' : '0 10%';
      els += `<div class="bub" style="${pos}border-radius:${rad};background:${fill};border:3.5px solid ${stroke}"></div>`;
      txt += tx(`color:${dark ? '#fff' : '#111'};padding:${pad}`);
    } else if (it.kind === 'cap') {
      els += `<div class="bub" style="${pos}background:#fff3b0;border:3px solid #333"></div>`;
      txt += tx('color:#222;padding:0 14px;font-style:italic');
    } else if (it.kind === 'sign') {
      els += `<div style="position:absolute;left:${it.x + it.w / 2 - 12}px;top:${it.y + it.h}px;width:24px;height:90px;background:#6b4423;border:3px solid #111"></div>`;
      els += `<div class="bub" style="${pos}background:#8a5a2b;border:5px solid #3b2410"></div>`;
      txt += tx('color:#fff;padding:0 16px;font-weight:bold');
    } else if (it.kind === 'sfx') {
      txt += tx(`color:${it.color};-webkit-text-stroke:6px #1a1a1a;paint-order:stroke fill;font-weight:bold;letter-spacing:2px`);
    }
  });
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;background:#fff}
#stage{position:relative;width:${w}px;height:${h}px;background:#fdfdfb;overflow:hidden;font-family:${FONT};font-weight:bold}
.bub{position:absolute;box-sizing:border-box;display:flex;align-items:center;justify-content:center;text-align:center}
.t{margin:0;line-height:1.22}
svg{position:absolute;left:0;top:0}
</style></head><body><div id="stage">${panels}
<svg width="${w}" height="${h}">${fig}${tailsU}</svg>${els}<svg width="${w}" height="${h}">${tailsO}</svg>${txt}
</div></body></html>`;
}

/* ------------------------------------------------------------------ */
const browser = await chromium.launch({ executablePath: chromiumExe(), headless: true });
const comic = {};
for (const [name, spec] of [['page1', page1], ['strip', strip]]) {
  const page = await browser.newPage({ viewport: { width: spec.w, height: Math.min(spec.h, 2000) }, deviceScaleFactor: 1 });
  await page.setContent(comicHTML(spec));
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(150);
  // the tail overlay svg sits above text elements; it only paints white tails, fine.
  const boxes = await page.evaluate(() => [...document.querySelectorAll('.t')].map(el => {
    const st = document.getElementById('stage').getBoundingClientRect();
    const r = document.createRange(); r.selectNodeContents(el);
    let x1 = 1e9, y1 = 1e9, x2 = -1e9, y2 = -1e9;
    for (const q of r.getClientRects()) { if (!q.width) continue; x1 = Math.min(x1, q.left - st.left); y1 = Math.min(y1, q.top - st.top); x2 = Math.max(x2, q.right - st.left); y2 = Math.max(y2, q.bottom - st.top); }
    return { i: +el.dataset.i, box: [Math.floor(x1), Math.floor(y1), Math.ceil(x2), Math.ceil(y2)] };
  }));
  await page.locator('#stage').screenshot({ path: path.join(FIX, name + '.png') });
  comic[name] = {
    w: spec.w, h: spec.h,
    regions: spec.items.map((it, i) => ({ box: boxes.find(b => b.i === i).box, type: it.type, text: it.text, ar: it.ar })),
  };
  await page.close();
}
fs.writeFileSync(path.join(FIX, 'comic.json'), JSON.stringify(comic, null, 2));
await browser.close();

/* ------------------------------------------------------------------ */
/* HTML fixtures                                                       */
/* ------------------------------------------------------------------ */
const icon = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="7" fill="#d9822b"/></svg>');

const sec = (n, h, ps) => `<section id="sec${n}" class="sec"><h2 id="h2-${n}">${h}</h2>\n${ps.map((p, i) => `<p id="s${n}p${i + 1}">${p}</p>`).join('\n')}</section>`;
const filler = [
  'Good bread asks for patience more than skill, and the oven only finishes what the dough has already decided to become.',
  'Every baker eventually learns that the weather in the kitchen matters as much as the recipe on the page.',
  'A warm loaf cut too early will taste gummy, so the hardest part of the whole process is simply waiting.',
];

const pageHtml = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>The Slow Art of Baking Bread at Home</title>
<style>
body{font:17px/1.6 Georgia,serif;max-width:880px;margin:0 auto;padding:0 20px;color:#222;background:#fffdf8}
nav{display:flex;gap:18px;padding:14px 0;border-bottom:2px solid #d9c9a8;font-family:Arial,sans-serif}
nav a{color:#8a4b12;text-decoration:none}
.sec{min-height:640px;border-top:1px dashed #ccc;padding-top:10px}
pre{background:#272822;color:#f8f8f2;padding:10px;overflow:auto}
code{background:#eee;padding:0 4px}
table{border-collapse:collapse}td,th{border:1px solid #aaa;padding:4px 10px}
#mixed{border:1px solid #bbb;padding:8px}
</style></head><body>
<nav id="nav"><a id="nav1" href="/page.html">Home</a><a id="nav2" href="/page.html#recipes">Recipes</a><a id="nav3" href="/page.html#tools">Tools</a><a id="nav4" href="/page.html#contact">Contact us</a></nav>
<header><h1 id="h1">The Slow Art of Baking Bread at Home</h1></header>
<main id="main">
<section id="sec1" class="sec">
<h2 id="h2-1">Why bread takes so long</h2>
<p id="p1">Baking bread at home is a quiet hobby that rewards <b id="b1">patience</b> and a little curiosity. Most beginners rush the first rise, and the loaf pays for it.</p>
<p id="p2">Read the <a id="lnk1" href="https://example.com/guide">beginner guide</a> before you start, then keep a <em id="em1">simple notebook</em> next to the oven.<br>The second line of this paragraph begins after a line break.</p>
<p id="p3">Set the oven with <code id="code1">bake --temp 230</code> on your phone timer app if you like, but trust your nose more than the clock <img id="icon" src="${icon}" alt="oven icon" width="16" height="16"> when the crust starts to smell sweet.</p>
<p id="p4">Our kitchen has <a id="lnk2" href="https://example.com/tools?x=1&amp;y=2" title="Tool list">a few essential tools</a>, and <a id="lnk3" href="/page.html#more">some optional extras</a> that we rarely use.</p>
<h3 id="h3-1">What you need</h3>
<ul id="ul1"><li id="li1">Strong flour, preferably with a high protein content</li><li id="li2">Fresh yeast or a lively sourdough starter</li><li id="li3">A heavy pot with a <a id="lnk4" href="https://example.com/lid">tight lid</a></li></ul>
<ol id="ol1"><li id="oli1">Mix the flour and water, then rest the dough for an hour.</li><li id="oli2">Fold the dough every thirty minutes.</li><li id="oli3">Shape the loaf and let it rise overnight.</li></ol>
<table id="tbl"><thead><tr><th id="th1">Ingredient</th><th id="th2">Amount</th></tr></thead><tbody><tr><td id="td1">Flour</td><td id="td2">500 grams</td></tr><tr><td id="td3">Water</td><td id="td4">350 grams</td></tr></tbody></table>
<p><button id="btn" type="button">Start the timer</button> <input id="inp" type="text" placeholder="Enter your email address" value="baker@example.com"></p>
<pre id="pre">function rise(hours) {
  return hours * 60; // minutes
}</pre>
<p id="ar" dir="rtl" lang="ar">الخبز المنزلي هواية هادئة تحتاج إلى الصبر وقليل من الفضول.</p>
<p>Brand name: <span id="notrans" translate="no">Maana Bakery Supplies</span> is a fictional shop.</p>
<p id="hidden" style="display:none">This hidden paragraph must never be translated.</p>
<div id="mixed">Loose text before the block children, with some <b id="mb">bold words</b> inside it.
<p id="mx1">The first block child sits inside the mixed container.</p>
<p id="mx2">The second block child has a <a id="lnk5" href="https://example.com/mixed">link</a> as well.</p>
Loose trailing text after the blocks.</div>
<p id="reorder">The REORDER paragraph keeps <a id="lnkr" href="https://example.com/reorder">one special link</a> in the middle of its sentence, followed by trailing words.</p>
<p id="dropt">The DROPTAG paragraph has a <a id="lnkd" href="https://example.com/droptag">single link</a> and also <b id="bd">some bold words</b> that the model may drop.</p>
<p id="skip">The SKIPME paragraph has a <a id="lnks" href="https://example.com/skipme">link</a> that must survive even if the model skips this item.</p>
</section>
${sec(2, 'Flour and water', filler.concat(['Hydration is just the ratio of water to flour, but it changes everything about how the dough feels in your hands.']))}
${sec(3, 'Starting a sourdough culture', filler)}
${sec(4, 'Shaping and scoring', filler)}
${sec(5, 'Baking in a pot', filler)}
${sec(6, 'Troubleshooting dense loaves', filler)}
${sec(7, 'Storing and freezing', filler.concat(['Slice the loaf before freezing it, so you can take out only what you need for breakfast.']))}
<section id="sec8" class="sec"><h2 id="h2-8">Far below the fold</h2>
<p id="far1">This paragraph lives far below the first screens and should stay in English until the reader scrolls down to it.</p>
<p id="far2">A second distant paragraph with <a id="lnkf" href="https://example.com/far">a faraway link</a> keeps it company.</p></section>
${sec(9, 'Final thoughts', ['Bake often, take notes, and share the loaf with someone who will appreciate it.'])}
</main>
<footer id="foot"><p id="footp">Thank you for reading, and happy baking.</p></footer>
<script>setTimeout(function(){var p=document.createElement('p');p.id='late';p.textContent='This late paragraph appears after the page has loaded and should still get translated.';document.getElementById('sec1').appendChild(p);},1500);</script>
</body></html>`;
fs.writeFileSync(path.join(FIX, 'page.html'), pageHtml);

const idioms = [
  "Honestly, I'm not saying the project is a disaster, but we're definitely between a rock and a hard place right now.",
  'She finally bit the bullet and told her boss that the deadline was out of the question.',
  "Don't beat around the bush, just tell me whether the new design is a hit or a miss.",
  "It's a long shot, but if we play our cards right, the client might still come around.",
  'After weeks of silence, he called me out of the blue and asked if I wanted to grab a coffee.',
  "Look, I know you're under the weather, so take the day off and we'll catch up when you're back on your feet.",
  'The new manager really knows how to read the room, which is why the team trusts her so much.',
  'I told him a hundred times to keep it under wraps, but he let the cat out of the bag at lunch.',
  "Frankly, that movie was nothing to write home about, though the soundtrack was the cherry on top.",
  'We were all hoping for a miracle, but the match went downhill fast and ended in a painful draw.',
  "No offence, but your plan sounds a bit half-baked; maybe we should go back to the drawing board?",
  "At the end of the day, it doesn't matter who wins, as long as we leave with our heads held high.",
];
fs.writeFileSync(path.join(FIX, 'idioms.html'), `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Idioms and tone</title>
<style>body{font:18px/1.7 Georgia,serif;max-width:760px;margin:30px auto;padding:0 20px}</style></head><body>
<h1 id="h1">Idioms and tone: a manual quality check</h1>
${idioms.map((t, i) => `<p id="i${i + 1}">${t}</p>`).join('\n')}
</body></html>`);

const comicPage = (dir, title) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{margin:0 auto;width:720px;background:#ddd}img{display:block;width:720px;height:auto;margin:0 0 20px}#thumb{width:120px}</style></head><body>
<img id="p1" src="http://127.0.0.1:8788/${dir}page1.png" alt="page one">
<img id="strip" src="http://127.0.0.1:8788/${dir}strip.png" alt="long strip">
<img id="thumb" width="120" src="http://127.0.0.1:8788/${dir}page1.png" alt="thumbnail">
</body></html>`;
fs.writeFileSync(path.join(FIX, 'comic.html'), comicPage('', 'Comic test'));
fs.writeFileSync(path.join(FIX, 'comic-ref.html'), comicPage('ref/', 'Comic test (referer-protected)'));

console.log('fixtures written to', FIX);
for (const k of Object.keys(comic)) console.log(k, comic[k].w + 'x' + comic[k].h, comic[k].regions.length, 'regions');
