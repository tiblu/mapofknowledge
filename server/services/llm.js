const Anthropic = require('@anthropic-ai/sdk');
const https     = require('https');
const db        = require('../db');

// maxRetries: the SDK's built-in retry (network errors, 408/409/429/5xx) covers
// every non-streaming call here. It does NOT cover a stream that dies mid-flight
// (see _streamText below for that case) — a stream can't be safely resumed once
// partial output has already been consumed.
//
// keepAlive: false — pooled/reused connections to api.anthropic.com from this
// zone.ee host intermittently die mid-response ("Premature close"), recurring
// across many days in pm2 logs on both this project and KnobitMap (same
// symptom, fixed there the same way 2026-07-xx). A fresh connection per
// request avoids the reuse entirely.
const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  maxRetries: 3,
  httpAgent: new https.Agent({ keepAlive: false }),
});

function _logUsage(userId, callType, usage, model) {
  if (!userId || !usage) return;
  db.execute(
    'INSERT INTO token_usage (user_id, call_type, input_tokens, output_tokens, model) VALUES (?, ?, ?, ?, ?)',
    [userId, callType, usage.input_tokens || 0, usage.output_tokens || 0, model]
  ).catch(() => {});
}

// LLMs sometimes wrap JSON in markdown fences despite instructions.
// Strip them before parsing.
function parseJSON(text) {
  const cleaned = text.trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/,     '')
    .replace(/```\s*$/,     '')
    .trim();
  return JSON.parse(cleaned);
}

const HAIKU  = 'claude-haiku-4-5';
const SONNET = 'claude-sonnet-4-6';

const LANG_NAMES = { et: 'Estonian (Eesti keel)' };

const VIZ_INSTRUCTIONS = `Decide whether a visual would genuinely help a learner understand this explanation better.

Show a visual ONLY when the concept has clear visual form: physical objects, organisms, geographic features,
spatial relationships, mechanical diagrams, step-by-step processes with distinct stages, or mathematical
structures where seeing the shape is the insight. Ask: would a good textbook include a figure here?

Skip a visual when: the content is primarily about definitions, relationships between ideas, history,
social phenomena, logic, abstract principles, or any case where a picture adds atmosphere but not understanding.
If in doubt, skip — a missing visual is fine; an irrelevant one is distracting.

If a visual IS warranted:
1. Prefer Wikimedia Commons. Return the Commons file page URL in the format
   https://commons.wikimedia.org/wiki/File:EXACT_FILENAME — never construct upload.wikimedia.org URLs yourself.
2. If nothing suitable exists there, these other reputable, freely-usable sources are also acceptable — for
   these, return the DIRECT image file URL itself (ending .jpg/.jpeg/.png/.svg/.webp — a URL that loads the raw
   image, never a webpage that merely displays or links to it):
   - NASA (any nasa.gov subdomain, e.g. images.nasa.gov) — public domain
   - Smithsonian Institution (si.edu) — public domain / open access
   - U.S. federal science or health agencies (.gov domains, e.g. noaa.gov, usgs.gov, nih.gov, cdc.gov) — public domain
   - Openverse (openverse.org) results, only if explicitly licensed CC0, CC-BY, or Public Domain
   - Pixabay (pixabay.com), Unsplash (unsplash.com), Pexels (pexels.com) — free-to-use stock libraries
   Hard rule regardless of source: reject any image with a visible copyright notice, watermark, company logo,
   stock-agency mark, or © mark.
   Only use YouTube if the concept specifically requires motion or animation to understand (e.g. a physical
   process, a technique, a demonstration) — not just because no image was found.
3. If nothing genuinely useful exists across all of the above: set visual to null.`;

// Finds and parses the first complete {...} JSON object in a string,
// ignoring any surrounding prose or reasoning text Claude may output.
function _extractJSON(text) {
  let depth = 0, start = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (text[i] === '}') {
      depth--;
      if (depth === 0 && start !== -1) return JSON.parse(text.slice(start, i + 1));
    }
  }
  throw new Error('No JSON object found');
}

// Resolves a commons.wikimedia.org/wiki/File:... page URL to a direct image URL
// via the Wikimedia API. Returns the direct URL or null on failure.
async function _resolveWikimediaUrl(url) {
  const match = url.match(/commons\.wikimedia\.org\/wiki\/File:(.+?)(?:\?.*)?$/i);
  if (!match) return url;
  const filename = decodeURIComponent(match[1]);
  try {
    const apiUrl = 'https://commons.wikimedia.org/w/api.php?action=query' +
      '&titles=File:' + encodeURIComponent(filename) +
      '&prop=imageinfo&iiprop=url&format=json&origin=*';
    const resp = await fetch(apiUrl, {
      headers: { 'User-Agent': 'MapOfKnowledge/1.0 (educational platform)' },
      signal: AbortSignal.timeout(5000),
    });
    const data = await resp.json();
    const pages = data.query?.pages;
    if (!pages) return null;
    const page = Object.values(pages)[0];
    return page?.imageinfo?.[0]?.url || null;
  } catch {
    return null;
  }
}

async function _callWithWebSearch(config) {
  const messages = [...config.messages];
  for (let i = 0; i < 5; i++) {
    const resp = await client.messages.create({ ...config, messages });
    if (resp.stop_reason !== 'tool_use') return resp;
    messages.push({ role: 'assistant', content: resp.content });
    const results = resp.content
      .filter(b => b.type === 'tool_use')
      .map(b => ({ type: 'tool_result', tool_use_id: b.id, content: 'No results.' }));
    if (!results.length) return resp;
    messages.push({ role: 'user', content: results });
  }
  return await client.messages.create({ ...config, messages });
}

function langText(locale) {
  if (!locale || locale === 'en') return '';
  const name = LANG_NAMES[locale] || locale;
  return `\n\nIMPORTANT: Write your entire response in ${name}.`;
}

function langJson(locale) {
  if (!locale || locale === 'en') return '';
  const name = LANG_NAMES[locale] || locale;
  return `\n\nIMPORTANT: Write all text content in ${name}. Keep JSON field names in English.`;
}

const PROFILE_INSTRUCTION = `Instructional relevance first. Use the profile where it makes bytes, examples, demonstration or practice tasks feel more natural — never to force a connection that isn't there. Age shapes vocabulary and analogy choice. Cultural background anchors examples in familiar territory (an Estonian and a Cairo-based learner studying fermentation will recognize different reference points — use the right ones). Learning needs adjust format and pace. Interests apply when a genuine bridge exists; if it would feel like a stretch, ignore it. Default rule: would a thoughtful human tutor who knew this person naturally reach for this example? If yes, use it. If not, don't.`;

const HATE = /\b(nazi|white.suprem|nigger|faggot|kike|slut|whore|chink|spic)\b/i;

function profileBlock(profile) {
  if (!profile) return '';
  const safe = v => (v && !HATE.test(String(v))) ? v : null;
  const parts = [];
  if (profile.birth_year) {
    const age = new Date().getFullYear() - profile.birth_year;
    if (age > 5 && age < 120) parts.push(`Age: ${age}`);
  }
  const loc  = safe(profile.location);            if (loc)  parts.push(`Language/location: ${loc}`);
  const cult = safe(profile.cultural_background); if (cult) parts.push(`Cultural background: ${cult}`);
  const abt  = safe(profile.about);               if (abt)  parts.push(`Learning needs: ${abt}`);
  const interests = (profile.interests || []).filter(s => !HATE.test(s));
  if (interests.length) parts.push(`Interests: ${interests.join(', ')}`);
  const values = (profile.values || []).filter(s => !HATE.test(s));
  if (values.length) parts.push(`Values: ${values.join(', ')}`);
  if (!parts.length) return '';
  return `\n\nLearner profile: ${parts.join('. ')}.\n${PROFILE_INSTRUCTION}`;
}

const TUTOR_SYSTEM = [
  {
    type: 'text',
    text: `You are an expert adaptive tutor inside the Map of Knowledge learning platform.
Your tone is clear, direct, and intellectually engaging.
Keep every response focused and concise. Never pad, never repeat.
Respond only with the content requested — no preamble, no headings.`,
    cache_control: { type: 'ephemeral' },
  },
];

// ── Overview ──────────────────────────────────────────────────────────────────
async function generateOverview(nodeLabel, domain, level, locale, userId) {
  const msg = await client.messages.create({
    model: SONNET,
    max_tokens: 200,
    system: TUTOR_SYSTEM,
    messages: [{
      role: 'user',
      content: `Write exactly 2 sentences describing "${nodeLabel}" (a level-${level} concept in ${domain}).
First sentence: what it is. Second sentence: why it matters or where it shows up.
No headings, no bullet points — just the 2 sentences.${langText(locale)}`,
    }],
  });
  _logUsage(userId, 'overview', msg.usage, SONNET);
  return msg.content[0].text.trim();
}

// ── Knobit generation ─────────────────────────────────────────────────────────
async function generateKnobits(nodeLabel, domain, breadcrumb, userId) {
  const msg = await client.messages.create({
    model: SONNET,
    max_tokens: 900,
    system: [{
      type: 'text',
      text: `You are a curriculum designer for the Map of Knowledge platform.
Each knobit is one atomic idea a learner must master before the next.
Respond only with valid JSON — no markdown fences, no commentary.`,
      cache_control: { type: 'ephemeral' },
    }],
    messages: [{
      role: 'user',
      content: `Design the complete knobit sequence for this L5 concept:
Topic: "${nodeLabel}"
Domain: ${domain}
Breadcrumb: ${breadcrumb}

Return a JSON array. Each object has exactly:
- "sequence": integer starting at 1
- "title": string (short knobit name, 3–8 words)
- "byteCount": integer — see below

Base the knobit count entirely on this topic's actual conceptual complexity — there is no target number to hit. A narrow or simple topic (a single technique, fact, or short procedure — e.g. "how to fold a paper airplane") may genuinely need only 2–4 knobits. A dense, multi-faceted topic may need up to 10–12. Most fall in between.

Do not pad the sequence. Never split one idea into multiple knobits just to lengthen the list, and never invent a step that isn't conceptually distinct from its neighbors — if two things are really one idea, they're one knobit.

For "byteCount": each knobit is taught as a sequence of "bytes," roughly 300 characters of explanation each. Predict how many bytes THIS SPECIFIC knobit genuinely needs to be taught properly — not a target to hit, an honest estimate of its real depth. Hard bounds: never below 3, never above 12. A narrow, shallow idea (e.g. "properties of a line" in geometry) might genuinely need only 4–5. A dense, layered idea (e.g. "black hole event horizon") might genuinely need 10–12. Judge each knobit independently — they don't all need the same count.`,
    }],
  });
  _logUsage(userId, 'knobits', msg.usage, SONNET);
  const knobits = parseJSON(msg.content[0].text.trim());
  return knobits.map(k => ({
    ...k,
    byteCount: Number.isInteger(k.byteCount) ? Math.min(12, Math.max(3, k.byteCount)) : 6,
  }));
}

// ── Signup: interest/value moderation ───────────────────────────────────────
// Fails open (allows through) on any error — a moderation-API hiccup should
// never block someone from signing up. Genuinely bad input just also has to
// clear this check next time it's called (e.g. a retry, or later editing).
async function moderateTags(interests, values) {
  const entries = [
    ...interests.map(t => ({ type: 'interest', text: t })),
    ...values.map(t => ({ type: 'value', text: t })),
  ];
  if (!entries.length) return { ok: true, flagged: [] };

  const numbered = entries.map((e, i) => `${i + 1}. [${e.type}] ${e.text}`).join('\n');

  try {
    const msg = await client.messages.create({
      model: HAIKU,
      max_tokens: 300,
      system: `You moderate signup-form entries for an all-ages K-12 online learning platform. Users list short "interest" and "value" entries describing themselves — this is used to personalise their learning content, not shown publicly.

Flag an entry only if it is: hate speech, a slur, promotion of illegal activity, sexual content, self-harm promotion, or otherwise clearly inappropriate for a school context. Do NOT flag entries just because they are ordinary, blunt, oddly phrased, in a language other than English/Estonian, or a value/interest you personally find unusual — genuine hobbies, subjects, and personal values (honesty, curiosity, football, painting, patience, etc.) are all fine.

Respond with ONLY minified JSON, no commentary, no markdown fences:
{"ok":true} if every entry is fine, or
{"ok":false,"flagged":["<verbatim entry text>", ...]} listing only the offending entries, copied exactly as given.`,
      messages: [{ role: 'user', content: numbered }],
    });
    _logUsage(null, 'moderate_tags', msg.usage, HAIKU);

    const parsed = parseJSON(msg.content[0].text);
    if (parsed && parsed.ok === false && Array.isArray(parsed.flagged)) {
      return { ok: false, flagged: parsed.flagged };
    }
    return { ok: true, flagged: [] };
  } catch (err) {
    return { ok: true, flagged: [] };
  }
}

// ── Knobit title translation ──────────────────────────────────────────────────
async function translateKnobitTitles(knobits, targetLocale, userId) {
  const langName = LANG_NAMES[targetLocale] || targetLocale;
  const msg = await client.messages.create({
    model: HAIKU,
    max_tokens: 600,
    system: 'You are a translator. Respond only with valid JSON — no markdown fences, no commentary.',
    messages: [{
      role: 'user',
      content: `Translate these knobit titles into ${langName}.
Keep each translation short (3–8 words), matching the style and concision of the originals.
Return a JSON array of strings in the same order as the input.

${JSON.stringify(knobits.map(k => k.title))}`,
    }],
  });
  _logUsage(userId, 'translate_titles', msg.usage, HAIKU);
  const translated = parseJSON(msg.content[0].text.trim());
  return knobits.map((k, i) => ({ ...k, title: (Array.isArray(translated) && translated[i]) || k.title }));
}

// ── Second-pass language editor ───────────────────────────────────────────────
// Locale-neutral: only locales with a configured prompt below get edited; every
// other locale (including 'en') is a no-op. Only 'et' is configured today.
const EDITOR_PROMPTS = {
  et: `Sa oled eesti keele keeletoimetaja õppematerjalide jaoks. Ma annan Sulle tekstilõike, mis on loodud õppija jaoks. Palun lähtu põhimõttest, et muudad või parandad ainult juhul, kui on õigekirja- või grammatikaviga. Kui otseselt viga ei ole, siis ainult stilistilisel põhjusel korrigeerima ei hakka. Selline minimalistlik, nii vähe kui võimalik lähenemine. Kui on valida erinevate sisuliselt korrektsete terminite vahel (nt matemaatikas või mujal), tuleks eelistada termineid, mis on Eestis haridussüsteemis kasutusel.

Sulle antakse JSON-objekt tekstiväljadega. Tagasta JSON täpselt samade võtmetega, väärtusteks parandatud tekst (või muutmata tekst, kui midagi parandada ei olnud). Säilita täpselt samad väljade tüübid mis sisendis (string jääb stringiks, massiiv jääb massiiviks, säilita massiivi pikkus). Ära lisa mingit muud teksti peale JSON-i.`,
};

async function editTranslatedText(fields, locale, userId) {
  const prompt = EDITOR_PROMPTS[locale];
  if (!prompt) return fields; // no editor configured for this locale — no-op, including 'en'
  try {
    const msg = await client.messages.create({
      model: SONNET,
      max_tokens: 1000,
      system: [{ type: 'text', text: prompt, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: `Input JSON:\n${JSON.stringify(fields)}` }],
    });
    _logUsage(userId, 'edit_translated', msg.usage, SONNET);
    const corrected = parseJSON(msg.content[0].text);
    const result = {};
    for (const key of Object.keys(fields)) {
      const orig = fields[key];
      const fixed = corrected[key];
      const typeOk = Array.isArray(orig)
        ? (Array.isArray(fixed) && fixed.length === orig.length)
        : typeof fixed === 'string';
      result[key] = typeOk ? fixed : orig; // per-field fallback, not all-or-nothing
    }
    return result;
  } catch (err) {
    console.error('[editTranslatedText]', err.message);
    return fields; // fail open — never block content delivery
  }
}

// ── Explain phase — text only (fast, no web search) ──────────────────────────
async function generateExplainByteText(nodeLabel, knobitTitle, byteIndex, previousContent, locale, profile, userId) {
  let prompt;
  if (byteIndex === 0 || !previousContent) {
    prompt = `Teaching knobit "${knobitTitle}" within topic "${nodeLabel}".

Write the OPENING explanation (byte 1). Introduce the core concept clearly and simply.
2–4 sentences of plain prose by default — no headings, no titles. If the content is genuine enumeration (distinct types, steps, or categories — not just multiple points about one idea), you may use a short bulleted or numbered list instead: bullets as lines starting with "- ", numbered items as lines starting with "1. ", "2. ", etc. Otherwise stay in flowing prose with no line breaks. Plain text only — no HTML tags, no markdown formatting (no **bold**, no _italic_, no backticks).${profileBlock(profile)}${langText(locale)}`;
  } else {
    prompt = `Teaching knobit "${knobitTitle}" within topic "${nodeLabel}".

Everything explained so far, which the learner has already read and understood (may be several paragraphs — this is the full explanation up to this point, not just the last bit):
"""
${previousContent}
"""

Write the NEXT step (byte ${byteIndex + 1}). Cover a new aspect or go one level deeper. Do NOT repeat or paraphrase anything already covered above.
2–4 sentences of plain prose by default — no headings, no titles. If the content is genuine enumeration (distinct types, steps, or categories — not just multiple points about one idea), you may use a short bulleted or numbered list instead: bullets as lines starting with "- ", numbered items as lines starting with "1. ", "2. ", etc. Otherwise stay in flowing prose with no line breaks. Plain text only — no HTML tags, no markdown formatting (no **bold**, no _italic_, no backticks).${profileBlock(profile)}${langText(locale)}`;
  }

  const msg = await client.messages.create({
    model: SONNET,
    max_tokens: 300,
    system: TUTOR_SYSTEM,
    messages: [{ role: 'user', content: prompt }],
  });
  _logUsage(userId, 'explain_text', msg.usage, SONNET);
  return msg.content[0].text.trim();
}

// ── Explain phase — visual only (deferred, uses web search) ──────────────────
// Returns { visual: { type, url, caption } | null }
async function generateExplainByteVisual(nodeLabel, knobitTitle, byteText, locale, userId, seenUrls = []) {
  const seenBlock = seenUrls.length
    ? `\nAlready shown in this session — do NOT reuse these URLs:\n${seenUrls.map(u => '- ' + u).join('\n')}\n`
    : '';
  const prompt = `A learner studying "${knobitTitle}" (part of "${nodeLabel}") just read this explanation:
"""
${byteText}
"""
${seenBlock}
${VIZ_INSTRUCTIONS}
${langJson(locale)}
Output ONLY a single JSON object — no markdown fences, no reasoning, no commentary outside the JSON:
{"visual":{"type":"image","url":"...","caption":"..."}|{"type":"video","url":"...","caption":"..."}|null}`;

  const resp = await _callWithWebSearch({
    model: SONNET,
    max_tokens: 500,
    tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    system: TUTOR_SYSTEM,
    messages: [{ role: 'user', content: prompt }],
  });

  const fullText = resp.content.filter(b => b.type === 'text').map(b => b.text).join('');
  if (!fullText) return { visual: null };

  let result;
  try {
    result = _extractJSON(fullText);
  } catch {
    return { visual: null };
  }

  if (result.visual?.type === 'image' && result.visual?.url) {
    const resolved = await _resolveWikimediaUrl(result.visual.url);
    if (resolved) result.visual.url = resolved;
    else result.visual = null;
  }

  _logUsage(userId, 'explain_visual', resp.usage, SONNET);
  return { visual: result.visual || null };
}

// ── Explain phase — ADAPT the current byte ───────────────────────────────────
// mode:
//   'rephrase' — "I don't understand": step back, explain from first principles
//   'simpler'  — "Too simplistic": rephrase with professional/expert language
//   'complex'  — "Too complex": rephrase with simpler words and analogies
async function generateRephrase(nodeLabel, knobitTitle, originalByte, mode, locale, profile, userId) {
  const instructions = {
    rephrase: `The learner did not understand this explanation. Step back further.
Explain the same concept from first principles — start from something even more basic,
use a concrete real-world analogy, and build up slowly.
Do NOT reuse the same wording. A different angle entirely.`,

    simpler: `The learner found this too simplistic.
Rewrite using more precise, formal, expert-level vocabulary and phrasing — elevate the WORDING only.
STRICT rules: keep the SAME number of sentences as the original, do not add sentences.
Do NOT introduce additional concepts, categories, sub-types, or examples beyond what the original already covered.
Same core idea, same scope, same length — just phrased the way a domain expert would say it.`,

    complex: `The learner found this too complex.
Rewrite using the simplest possible words. STRICT rules: every sentence must be at most 10 words long.
Maximum 3 sentences per paragraph. No jargon — replace every technical term with a plain everyday word.
Use one concrete real-life example (something a child could picture).
Same core concept — maximally accessible.`,
  }[mode] || 'Rewrite this explanation from a different angle.';

  const msg = await client.messages.create({
    model: SONNET,
    max_tokens: 350,
    system: TUTOR_SYSTEM,
    messages: [{
      role: 'user',
      content: `Topic: "${nodeLabel}" — Knobit: "${knobitTitle}"

Current explanation:
"""
${originalByte}
"""

${instructions}

Write the replacement text only — 2–4 sentences of plain prose by default, no headings or titles. If the content is genuine enumeration (distinct types, steps, or categories), you may use a short bulleted ("- item") or numbered ("1. item") list instead. Plain text only — no markdown formatting (no **bold**, no _italic_, no backticks).${profileBlock(profile)}${langText(locale)}`,
    }],
  });
  _logUsage(userId, 'rephrase', msg.usage, SONNET);
  return msg.content[0].text.trim();
}

// ── Demonstrate phase ─────────────────────────────────────────────────────────
async function generateDemonstrate(nodeLabel, knobitTitle, exampleIndex, locale, profile, userId, previousExample) {
  const priorBlock = previousExample
    ? `\n\nPrevious example already shown to the learner:\n"""\n${previousExample}\n"""\n\nWrite a DIFFERENT example — a distinct scenario or context, not a variation or rewording of the same one.`
    : '';
  const msg = await client.messages.create({
    model: SONNET,
    // Non-English locales (e.g. Estonian's case endings/compound words) need more
    // tokens to fit the same content — 350 was tuned for English and truncated
    // ~1 in 4 Estonian responses mid-JSON.
    max_tokens: locale === 'en' ? 350 : 600,
    system: TUTOR_SYSTEM,
    messages: [{
      role: 'user',
      content: `Topic: "${nodeLabel}" — Knobit: "${knobitTitle}"
Worked example number: ${exampleIndex + 1}${priorBlock}

Respond with valid JSON, two fields only:
- "body": a step-by-step worked example (2–5 sentences)
- "whatIDid": 1 sentence naming the key technique or insight used

No markdown fences. Just the JSON object.${profileBlock(profile)}${langJson(locale)}`,
    }],
  });
  _logUsage(userId, 'demonstrate', msg.usage, SONNET);
  return parseJSON(msg.content[0].text.trim());
}

// ── Practice phase ────────────────────────────────────────────────────────────
// learnedContent: the actual explain/demonstrate text generated for this learner's
// session (see api.js's _getLearnedContent, sourced from knobit_interactions) —
// grounds the question in what was really taught instead of inventing fresh,
// possibly contradictory or ungrounded trivia about the topic.
async function generatePractice(nodeLabel, knobitTitle, problemIndex, locale, profile, userId, learnedContent, priorQuestions = []) {
  const difficulty = problemIndex === 0 ? 'straightforward' : problemIndex === 1 ? 'moderate' : 'challenging';
  const contentBlock = learnedContent
    ? `\n\nWhat the learner has actually studied so far in this knobit:\n"""\n${learnedContent}\n"""\n`
    : '';
  const priorBlock = priorQuestions.length
    ? `\n\nPractice questions already asked earlier in this same knobit — the new question must test a genuinely different fact, aspect, or angle, not a reworded/renumbered version of one of these:\n${priorQuestions.map((q, i) => `${i + 1}. ${q}`).join('\n')}\n`
    : '';
  const msg = await client.messages.create({
    model: SONNET,
    max_tokens: 250,
    system: TUTOR_SYSTEM,
    messages: [{
      role: 'user',
      content: `Topic: "${nodeLabel}" — Knobit: "${knobitTitle}"
Practice problem ${problemIndex + 1} — difficulty: ${difficulty}
${contentBlock}${priorBlock}
Base the question strictly on the content above — do not introduce facts, names, agencies, dates, or figures that are not stated there. If the content mentions a specific institution or example only illustratively, do not turn it into a "name the exact institution" quiz question — narrow factual/administrative details can change over time and are not the point being taught. Favor questions that test understanding, reasoning, or application (e.g. "what would you do if...", "why does X matter here", "what is the key difference between...") over recall of a specific name, statistic, or institution.
Ask exactly ONE question. A short setup sentence for context is fine, but do NOT stack a second question onto it — no "and", no em dash, no semicolon joining two separate things being asked. There must be exactly one thing the learner needs to answer, with exactly one expected answer.

Respond with valid JSON, two fields only:
- "question": the problem statement — one short setup (optional) plus exactly one question (1–3 sentences total)
- "expected": the correct answer (brief — a number, term, or short phrase)

No markdown fences. Just the JSON object.${profileBlock(profile)}${langJson(locale)}`,
    }],
  });
  _logUsage(userId, 'practice', msg.usage, SONNET);
  return parseJSON(msg.content[0].text.trim());
}

// ── Grade a practice answer ───────────────────────────────────────────────────
async function gradePractice(nodeLabel, knobitTitle, question, expected, userAnswer, locale, userId, learnedContent) {
  const contentBlock = learnedContent
    ? `\n\nWhat the learner has actually studied so far in this knobit:\n"""\n${learnedContent}\n"""\n`
    : '';
  const msg = await client.messages.create({
    model: SONNET,
    max_tokens: 200,
    system: TUTOR_SYSTEM,
    messages: [{
      role: 'user',
      content: `Topic: "${nodeLabel}" — Knobit: "${knobitTitle}"
Question: "${question}"
Expected: "${expected}"
Learner's answer: "${userAnswer}"
${contentBlock}
Grade based on whether the learner's answer is consistent with the content above, not on an exact match against "Expected" — "Expected" was generated alongside the question and may itself be imprecise, incomplete, or outdated on a narrow factual detail (e.g. a specific institution name). If the learner's answer reflects genuine understanding of what was actually taught, mark it correct even if it doesn't match "Expected" word for word or names a different specific detail.

Respond with valid JSON, two fields only:
- "correct": boolean (true if the learner captures the essential idea)
- "feedback": 1–2 sentences — confirm if correct, or explain what's wrong

No markdown fences. Just the JSON object.${langJson(locale)}`,
    }],
  });
  _logUsage(userId, 'grade_practice', msg.usage, SONNET);
  return parseJSON(msg.content[0].text.trim());
}

// ── Meaning phase ─────────────────────────────────────────────────────────────
async function generateMeaning(nodeLabel, knobitTitle, locale, userId) {
  const msg = await client.messages.create({
    model: SONNET,
    max_tokens: 300,
    system: TUTOR_SYSTEM,
    messages: [{
      role: 'user',
      content: `Topic: "${nodeLabel}" — Knobit: "${knobitTitle}"

Write 2–3 sentences on why this matters in the real world.
Pick exactly ONE concrete anchor — a single profession, product, decision, or daily situation — where this directly applies. Do NOT cover more than one example or scenario.
Keep each sentence short and single-clause — one idea per sentence. Do NOT chain clauses with "because"/"since"/"if...then"/semicolons/dashes into one long compound sentence.
No "In conclusion" — just the insight.${langText(locale)}`,
    }],
  });
  _logUsage(userId, 'meaning', msg.usage, SONNET);
  return msg.content[0].text.trim();
}

// ── Ask anything ─────────────────────────────────────────────────────────────
async function answerQuestion(nodeLabel, knobitTitle, phase, question, context, locale, profile, userId) {
  const practiceRule = phase === 'practice'
    ? `\n\nPRACTICE PHASE — CRITICAL RULE: The learner is actively working on a practice problem. You must NEVER reveal, confirm, or strongly hint at the answer, even if asked directly. Instead offer a guiding question, point back to the relevant concept, or suggest a thinking approach. The learner must reach the answer themselves.`
    : '';

  const msg = await client.messages.create({
    model: SONNET,
    max_tokens: 300,
    system: [{
      type: 'text',
      text: `You are a focused learning assistant inside the Map of Knowledge platform.
You help the learner with exactly one concept:
  Knobit: "${knobitTitle}"
  Topic: "${nodeLabel}"

Rules:
1. Only answer questions relevant to this knobit or topic. If the question is clearly off-topic, reply warmly: "This chat is here to help you with '${knobitTitle}'. Happy to answer any questions about that!"
2. Be concise: 2–4 sentences. Never repeat what is already in the context.
3. No preamble — go straight to the helpful content.${practiceRule}`,
      cache_control: { type: 'ephemeral' },
    }],
    messages: [{
      role: 'user',
      content: `Phase: ${phase}
Recent content: "${context}"
Question: "${question}"${profileBlock(profile)}${langText(locale)}`,
    }],
  });
  _logUsage(userId, 'ask', msg.usage, SONNET);
  return msg.content[0].text.trim();
}

// ── 4-tier knowledge test ─────────────────────────────────────────────────────
// questionNum: 1-4  history: [{question, answer, correct}]
// Returns: { question, type: 'open'|'mcq', options?: string[] }

// Builds the Q4 (final) evaluation prompt. Shared by streaming and non-streaming paths.
function _buildLastEvalPrompt(nodeLabel, breadcrumb, historyText, options, correctIndex, userAnswer, locale) {
  const isMcq = Array.isArray(options) && typeof correctIndex === 'number';
  const q4Block = isMcq
    ? (() => {
        const mcqBlock = _mcqEvalBlock(userAnswer, options, correctIndex);
        return `Q4 is MCQ.\n${mcqBlock}\n\nQ4 scoring: Correct = 25 pts, Incorrect = 0 pts (same as Q1–Q3 — do NOT apply the graduated open-question rubric).`;
      })()
    : `For Q4, reason through the answer before scoring:

  Step 1 — What does the answer correctly demonstrate? Credit understanding shown through reasoning, examples, or application — even if the formal concept is not explicitly named.
  Step 2 — What is missing or imprecise?
  Step 3 — Assign Q4 a score (0–25):
    • 23–25: complete — all dimensions the question asked for are addressed
    • 15–22: strong — main concept correct, one dimension missing or unnamed but its logic is present in the reasoning
    •  8–14: partial — core is right but significant aspects are missing
    •  1–7:  surface level only
    •  0:    incorrect or no meaningful engagement

Key principle: demonstrating correct reasoning by example counts nearly as much as naming the concept. Naming a concept without showing you understand it counts for little.`;

  return `Topic: "${nodeLabel}" (${breadcrumb})

Full Q&A:
${historyText}

Only evaluate Q4 yourself — Q1–Q3 Verdicts are ground truth.
${q4Block}

Score each question out of 25.
Q1–Q3: use the Verdict line as ground truth — do not re-evaluate.
  • Verdict "Correct" → 25 pts.
  • Verdict "Incorrect" → 0 pts.
  • Verdict "Partial (score: N/25)" → use N pts exactly.
finalScore = Q1 score + Q2 score + Q3 score + Q4 score (total 0–100).

Return JSON:
- "correct": boolean — true only if Q4 score is 25
- "partial": boolean — true if Q4 score is 1–24
- "feedback": 2-3 sentences on the Q4 answer — acknowledge what was right, specify what was missing
- "finalScore": integer 0–100
- "scoreBreakdown": 2-4 sentences on overall performance — what the learner demonstrated, what they missed${langJson(locale)}`;
}

// Builds an unambiguous MCQ context block for the evaluator prompt.
// Returns null when options/correctIndex are absent (open question path).
function _mcqEvalBlock(userAnswer, options, correctIndex) {
  if (!Array.isArray(options) || !options.length || typeof correctIndex !== 'number') return null;
  const ans = (userAnswer || '').trim().toUpperCase();
  const selectedIdx = (ans.length === 1 && ans >= 'A' && ans <= 'D')
    ? ans.charCodeAt(0) - 65
    : (parseInt(ans, 10) - 1);
  const isCorrect = selectedIdx === correctIndex;
  const letter = (i) => String.fromCharCode(65 + i);
  const selectedText = (selectedIdx >= 0 && selectedIdx < options.length) ? options[selectedIdx] : userAnswer;
  return [
    'Options:',
    options.map((o, i) => `${letter(i)}. ${o}`).join('\n'),
    '',
    `Learner selected: ${selectedIdx >= 0 ? letter(selectedIdx) : ans}. ${selectedText}`,
    `Correct answer:   ${letter(correctIndex)}. ${options[correctIndex]}`,
    `Verdict: ${isCorrect ? 'CORRECT' : 'INCORRECT'}`,
  ].join('\n');
}

// Test question wording — age-based, opt-in only. Default (age unknown or 18+)
// is completely unchanged: this returns '' and the prompt is byte-for-byte
// identical to before. Only wording changes for a known under-18 learner —
// same question, same difficulty, same structure, simpler language.
function _simplifyWordingNote(age) {
  if (!age || age >= 18) return '';
  return '\n\nIMPORTANT: This learner is young. Use simple wording — short sentences, everyday vocabulary, no unnecessarily complex phrasing. Ask the exact same thing, at the exact same difficulty and depth — only the wording should be simpler.';
}

async function generateTestQuestion(nodeLabel, breadcrumb, questionNum, history, locale, userId, age = null) {
  const tiers = [
    'Factual (Remember): one question on core terminology or a foundational definition.',
    'Conceptual (Understand): one question asking the learner to explain a mechanism or relationship. No calculations.',
    'Procedural (Apply): one question requiring step-by-step execution with specific numbers/inputs.',
    'Analytical (Evaluate): one question presenting a scenario or anomaly to diagnose or critique.',
  ];

  const correctCount = history.filter(h => h.correct).length;
  const lastWasWrong = history.length > 0 && !history[history.length - 1].correct;
  const adaptNote = questionNum === 4 && correctCount >= 3
    ? 'The learner has done very well. Make this question genuinely expert-level.'
    : lastWasWrong
    ? 'The previous answer was incorrect. Adjust difficulty slightly downward.'
    : '';

  const historyText = history.map((h, i) =>
    `Q${i + 1}: ${h.question}\nAnswer: ${h.answer}\nCorrect: ${h.correct}`
  ).join('\n\n');

  const msg = await client.messages.create({
    model: SONNET,
    max_tokens: 800,
    system: [{
      type: 'text',
      text: `You are a knowledge diagnostic examiner. You generate exactly one question per tier of a 4-tier framework.
Return ONLY valid JSON with these fields:
- "question": the question text (string)
- "type": "open" or "mcq"
- "options": array of 4 strings if type is "mcq", omit if "open"
- "correctIndex": integer 0–3 indicating which option is correct, if type is "mcq"; omit if "open"
For MCQ: all four options must be similar in length and specificity. Distractors must be precise and plausible — not vague, not obviously wrong. A test-taker who doesn't know the topic must not be able to identify the correct answer by its style, length, or level of detail.
Do not add any explanation outside the JSON.`,
      cache_control: { type: 'ephemeral' },
    }],
    messages: [{
      role: 'user',
      content: `Topic: "${nodeLabel}" (${breadcrumb})
Tier ${questionNum}: ${tiers[questionNum - 1]}
${adaptNote}
${historyText ? `\nPrevious Q&A:\n${historyText}` : ''}

Generate question ${questionNum}. Choose open or MCQ based on what best tests this tier.
For MCQ: provide exactly 4 options, include correctIndex (0–3). Return JSON only.${langJson(locale)}${_simplifyWordingNote(age)}`,
    }],
  });

  _logUsage(userId, 'test_question', msg.usage, SONNET);
  return parseJSON(msg.content[0].text.trim());
}

// Evaluate one answer and return feedback.
// If questionNum === 4, also return final mastery score with breakdown.
async function evaluateTestAnswer(nodeLabel, breadcrumb, questionNum, question, options, userAnswer, correctIndex, history, locale, userId) {
  const isLast = questionNum === 4;
  const allQA = [...history, { question, answer: userAnswer }];
  const historyText = allQA.map((h, i) => {
    const isCurrentQ = i === allQA.length - 1;
    const _vLabel = h.correct ? 'Correct' : (h.partial ? 'Partial' : 'Incorrect');
    const _vScore = typeof h.score === 'number' ? ` (score: ${h.score}/25)` : '';
    const verdict = (!isCurrentQ && h.correct !== undefined)
      ? `\nVerdict: ${_vLabel}${_vScore}`
      : '';
    return `Q${i + 1}: ${h.question}\nAnswer: ${h.answer}${verdict}`;
  }).join('\n\n');

  const msg = await client.messages.create({
    model: SONNET,
    max_tokens: isLast ? 900 : 300,
    system: [{
      type: 'text',
      text: `You are a knowledge diagnostic evaluator. Return ONLY valid JSON. No text outside the JSON object.`,
      cache_control: { type: 'ephemeral' },
    }],
    messages: [{
      role: 'user',
      content: isLast
        ? _buildLastEvalPrompt(nodeLabel, breadcrumb, historyText, options, correctIndex, userAnswer, locale)
        : (() => {
            const mcq = _mcqEvalBlock(userAnswer, options, correctIndex);
            return mcq
              ? `Topic: "${nodeLabel}"\nQuestion: "${question}"\n\n${mcq}\n\nReturn JSON with:\n- "correct": boolean (use the Verdict above — do not re-evaluate)\n- "partial": false (MCQ is always fully correct or incorrect)\n- "feedback": 1-2 sentences — if correct, confirm and briefly explain why; if incorrect, explain what the right answer means${langJson(locale)}`
              : `Topic: "${nodeLabel}"\nQuestion: "${question}"\nAnswer: "${userAnswer}"\n\nReturn JSON with:\n- "correct": boolean — true if the answer reflects a good grasp and understanding of the issue\n- "partial": boolean — true if partially correct or noticeably incomplete\n- "score": integer 0–25 (25 = full understanding; 15–24 = good grasp with minor gaps; 8–14 = partial; 1–7 = surface only; 0 = incorrect)\n- "feedback": 1-2 sentences — confirm if correct, note what's missing if partial, or explain the right answer if wrong${langJson(locale)}`;
          })(),
    }],
  });

  _logUsage(userId, 'test_evaluate', msg.usage, SONNET);
  return parseJSON(msg.content[0].text.trim());
}

// ── Text streaming (SDK 0.39.x: create({stream:true}) → Promise<Stream>) ───────
// Calls onChunk for each text token; resolves when the stream ends.
//
// client's maxRetries doesn't cover this: once a stream has delivered partial
// output, the SDK won't (and can't safely) resume it after a connection drop.
// A "Premature close" here recurs regularly (zone.ee ↔ Anthropic connection
// flakiness — seen across many days in pm2 logs), so we retry silently,
// server-side, from scratch, but only while nothing has reached the caller's
// onChunk yet. Once real output has been emitted, the caller (learning.js) has
// its own from-scratch retry/backoff for a mid-stream drop — just propagate.
async function _streamText(config, userId, callType, onChunk) {
  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let emittedAny = false;
    try {
      const stream = await client.messages.create(Object.assign({}, config, { stream: true }));
      let inputTokens = 0, outputTokens = 0;
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta && event.delta.type === 'text_delta') {
          emittedAny = true;
          onChunk(event.delta.text);
        } else if (event.type === 'message_start' && event.message && event.message.usage) {
          inputTokens = event.message.usage.input_tokens || 0;
        } else if (event.type === 'message_delta' && event.usage) {
          outputTokens = event.usage.output_tokens || 0;
        }
      }
      _logUsage(userId, callType, { input_tokens: inputTokens, output_tokens: outputTokens }, config.model);
      return;
    } catch (err) {
      if (emittedAny || attempt === MAX_ATTEMPTS) throw err;
      console.error(`[stream] attempt ${attempt}/${MAX_ATTEMPTS} failed before any output (${err.message}) — retrying silently`);
    }
  }
}

function streamExplainByteText(nodeLabel, knobitTitle, byteIndex, previousContent, locale, profile, userId, onChunk) {
  let prompt;
  if (byteIndex === 0 || !previousContent) {
    prompt = `Teaching knobit "${knobitTitle}" within topic "${nodeLabel}".\n\nWrite the OPENING explanation (byte 1). Introduce the core concept clearly and simply.\n2–4 sentences of plain prose by default — no headings, no titles. If the content is genuine enumeration (distinct types, steps, or categories — not just multiple points about one idea), you may use a short bulleted or numbered list instead: bullets as lines starting with "- ", numbered items as lines starting with "1. ", "2. ", etc. Otherwise stay in flowing prose with no line breaks. Plain text only — no HTML tags, no markdown formatting (no **bold**, no _italic_, no backticks).${profileBlock(profile)}${langText(locale)}`;
  } else {
    prompt = `Teaching knobit "${knobitTitle}" within topic "${nodeLabel}".\n\nEverything explained so far, which the learner has already read and understood (may be several paragraphs — this is the full explanation up to this point, not just the last bit):\n"""\n${previousContent}\n"""\n\nWrite the NEXT step (byte ${byteIndex + 1}). Cover a new aspect or go one level deeper. Do NOT repeat or paraphrase anything already covered above.\n2–4 sentences of plain prose by default — no headings, no titles. If the content is genuine enumeration (distinct types, steps, or categories — not just multiple points about one idea), you may use a short bulleted or numbered list instead: bullets as lines starting with "- ", numbered items as lines starting with "1. ", "2. ", etc. Otherwise stay in flowing prose with no line breaks. Plain text only — no HTML tags, no markdown formatting (no **bold**, no _italic_, no backticks).${profileBlock(profile)}${langText(locale)}`;
  }
  return _streamText({ model: SONNET, max_tokens: 300, system: TUTOR_SYSTEM, messages: [{ role: 'user', content: prompt }] }, userId, 'explain_text', onChunk);
}

function streamRephrase(nodeLabel, knobitTitle, originalByte, mode, locale, profile, userId, onChunk) {
  const instructions = {
    rephrase: `The learner did not understand this explanation. Step back further.\nExplain the same concept from first principles — start from something even more basic,\nuse a concrete real-world analogy, and build up slowly.\nDo NOT reuse the same wording. A different angle entirely.`,
    simpler:  `The learner found this too simplistic.\nRewrite using more precise, formal, expert-level vocabulary and phrasing — elevate the WORDING only.\nSTRICT rules: keep the SAME number of sentences as the original, do not add sentences.\nDo NOT introduce additional concepts, categories, sub-types, or examples beyond what the original already covered.\nSame core idea, same scope, same length — just phrased the way a domain expert would say it.`,
    complex:  `The learner found this too complex.\nRewrite using the simplest possible words. STRICT rules: every sentence must be at most 10 words long.\nMaximum 3 sentences per paragraph. No jargon — replace every technical term with a plain everyday word.\nUse one concrete real-life example (something a child could picture).\nSame core concept — maximally accessible.`,
  }[mode] || 'Rewrite this explanation from a different angle.';
  const prompt = `Topic: "${nodeLabel}" — Knobit: "${knobitTitle}"\n\nCurrent explanation:\n"""\n${originalByte}\n"""\n\n${instructions}\n\nWrite the replacement text only — 2–4 sentences of plain prose by default, no headings or titles. If the content is genuine enumeration (distinct types, steps, or categories), you may use a short bulleted ("- item") or numbered ("1. item") list instead. Plain text only — no markdown formatting (no **bold**, no _italic_, no backticks).${profileBlock(profile)}${langText(locale)}`;
  return _streamText({ model: SONNET, max_tokens: 350, system: TUTOR_SYSTEM, messages: [{ role: 'user', content: prompt }] }, userId, 'rephrase', onChunk);
}

function streamMeaning(nodeLabel, knobitTitle, locale, userId, onChunk) {
  const prompt = `Topic: "${nodeLabel}" — Knobit: "${knobitTitle}"\n\nWrite 2–3 sentences on why this matters in the real world.\nPick exactly ONE concrete anchor — a single profession, product, decision, or daily situation — where this directly applies. Do NOT cover more than one example or scenario.\nKeep each sentence short and single-clause — one idea per sentence. Do NOT chain clauses with "because"/"since"/"if...then"/semicolons/dashes into one long compound sentence.\nNo "In conclusion" — just the insight.${langText(locale)}`;
  return _streamText({ model: SONNET, max_tokens: 300, system: TUTOR_SYSTEM, messages: [{ role: 'user', content: prompt }] }, userId, 'meaning', onChunk);
}

function streamAnswerQuestion(nodeLabel, knobitTitle, phase, question, context, locale, profile, userId, onChunk) {
  const practiceRule = phase === 'practice'
    ? `\n\nPRACTICE PHASE — CRITICAL RULE: The learner is actively working on a practice problem. You must NEVER reveal, confirm, or strongly hint at the answer, even if asked directly. Instead offer a guiding question, point back to the relevant concept, or suggest a thinking approach. The learner must reach the answer themselves.`
    : '';
  return _streamText({
    model: SONNET,
    max_tokens: 300,
    system: [{
      type: 'text',
      text: `You are a focused learning assistant inside the Map of Knowledge platform.\nYou help the learner with exactly one concept:\n  Knobit: "${knobitTitle}"\n  Topic: "${nodeLabel}"\n\nRules:\n1. Only answer questions relevant to this knobit or topic. If the question is clearly off-topic, reply warmly: "This chat is here to help you with '${knobitTitle}'. Happy to answer any questions about that!"\n2. Be concise: 2–4 sentences. Never repeat what is already in the context.\n3. No preamble — go straight to the helpful content.${practiceRule}`,
      cache_control: { type: 'ephemeral' },
    }],
    messages: [{ role: 'user', content: `Phase: ${phase}\nRecent content: "${context}"\nQuestion: "${question}"${profileBlock(profile)}${langText(locale)}` }],
  }, userId, 'ask', onChunk);
}

function streamTestQuestion(nodeLabel, breadcrumb, questionNum, history, locale, userId, onChunk, age = null) {
  const tiers = [
    'Factual (Remember): one question on core terminology or a foundational definition.',
    'Conceptual (Understand): one question asking the learner to explain a mechanism or relationship. No calculations.',
    'Procedural (Apply): one question requiring step-by-step execution with specific numbers/inputs.',
    'Analytical (Evaluate): one question presenting a scenario or anomaly to diagnose or critique.',
  ];
  const correctCount = history.filter(function (h) { return h.correct; }).length;
  const lastWasWrong = history.length > 0 && !history[history.length - 1].correct;
  const adaptNote = questionNum === 4 && correctCount >= 3
    ? 'The learner has done very well. Make this question genuinely expert-level.'
    : lastWasWrong ? 'The previous answer was incorrect. Adjust difficulty slightly downward.' : '';
  const historyText = history.map(function (h, i) {
    return `Q${i + 1}: ${h.question}\nAnswer: ${h.answer}\nCorrect: ${h.correct}`;
  }).join('\n\n');
  return _streamText({
    model: SONNET,
    max_tokens: 800,
    system: [{
      type: 'text',
      text: `You are a knowledge diagnostic examiner. You generate exactly one question per tier of a 4-tier framework.\nReturn ONLY valid JSON with these fields:\n- "question": the question text (string)\n- "type": "open" or "mcq"\n- "options": array of 4 strings if type is "mcq", omit if "open"\n- "correctIndex": integer 0–3 indicating which option is correct, if type is "mcq"; omit if "open"\nFor MCQ: all four options must be similar in length and specificity. Distractors must be precise and plausible — not vague, not obviously wrong. A test-taker who doesn't know the topic must not be able to identify the correct answer by its style, length, or level of detail.\nDo not add any explanation outside the JSON.`,
      cache_control: { type: 'ephemeral' },
    }],
    messages: [{
      role: 'user',
      content: `Topic: "${nodeLabel}" (${breadcrumb})\nTier ${questionNum}: ${tiers[questionNum - 1]}\n${adaptNote}\n${historyText ? `\nPrevious Q&A:\n${historyText}` : ''}\n\nGenerate question ${questionNum}. Choose open or MCQ based on what best tests this tier.\nFor MCQ: provide exactly 4 options, include correctIndex (0–3). Return JSON only.${langJson(locale)}${_simplifyWordingNote(age)}`,
    }],
  }, userId, 'test_question', onChunk);
}

function streamTestEvaluate(nodeLabel, breadcrumb, questionNum, question, options, userAnswer, correctIndex, history, locale, userId, onChunk) {
  const isLast = questionNum === 4;
  const allQA = [...history, { question, answer: userAnswer }];
  const historyText = allQA.map(function (h, i) {
    const isCurrentQ = i === allQA.length - 1;
    const _vLabel = h.correct ? 'Correct' : (h.partial ? 'Partial' : 'Incorrect');
    const _vScore = typeof h.score === 'number' ? ` (score: ${h.score}/25)` : '';
    const verdict = (!isCurrentQ && h.correct !== undefined)
      ? `\nVerdict: ${_vLabel}${_vScore}`
      : '';
    return `Q${i + 1}: ${h.question}\nAnswer: ${h.answer}${verdict}`;
  }).join('\n\n');
  return _streamText({
    model: SONNET,
    max_tokens: isLast ? 900 : 300,
    system: [{
      type: 'text',
      text: `You are a knowledge diagnostic evaluator. Return ONLY valid JSON. No text outside the JSON object.`,
      cache_control: { type: 'ephemeral' },
    }],
    messages: [{
      role: 'user',
      content: isLast
        ? _buildLastEvalPrompt(nodeLabel, breadcrumb, historyText, options, correctIndex, userAnswer, locale)
        : (function () {
            var mcq = _mcqEvalBlock(userAnswer, options, correctIndex);
            return mcq
              ? `Topic: "${nodeLabel}"\nQuestion: "${question}"\n\n${mcq}\n\nReturn JSON with:\n- "correct": boolean (use the Verdict above — do not re-evaluate)\n- "partial": false (MCQ is always fully correct or incorrect)\n- "feedback": 1-2 sentences — if correct, confirm and briefly explain why; if incorrect, explain what the right answer means${langJson(locale)}`
              : `Topic: "${nodeLabel}"\nQuestion: "${question}"\nAnswer: "${userAnswer}"\n\nReturn JSON with:\n- "correct": boolean — true if the answer reflects a good grasp and understanding of the issue\n- "partial": boolean — true if partially correct or noticeably incomplete\n- "score": integer 0–25 (25 = full understanding; 15–24 = good grasp with minor gaps; 8–14 = partial; 1–7 = surface only; 0 = incorrect)\n- "feedback": 1-2 sentences — confirm if correct, note what's missing if partial, or explain the right answer if wrong${langJson(locale)}`;
          })(),
    }],
  }, userId, 'test_evaluate', onChunk);
}

// ── Anne — persistent mentor chat widget ──────────────────────────────────────
// ANNE_APP_HELP: plain-language reference to the app's actual UI, so Anne can
// answer "how do I..." questions and guide a lost learner, not just coach on
// study habits. Keep this in sync when learner-facing UI changes — it's a
// static block, not derived from the code, so it goes stale silently.
// Deliberately omits: teacher/parent account linking (MoK has neither), and
// any gamification mechanics beyond the generic "achievements" already used
// on the Help page — MoK's gamification design is being redone separately,
// so this shouldn't bake in KnobitMap-specific terms (lumens, rank).
const ANNE_APP_HELP = {
  et: `Sa oskad õppijat aidata ka platvormi kasutamisel, kui ta on eksinud või ei tea, kuidas midagi teha. Nii Map of Knowledge töötab:

KAART: Õppija näeb interaktiivset teadmiste kaarti viie tasemega (L1 valdkonnad kuni L5 üksikmõisted). Kaarti saab lohistada ja suumida, mõisteid otsida ülal otsingukastist, ning kasutada vasakul filtreid (nt põhikool/gümnaasium, aine) ja kihte, et kaarti selgemaks muuta.

SÕLME KLIKKIMINE: Kui õppija klikib mõistel, avaneb külgpaneel. Nupud sõltuvad mõiste tasemest:
- L1–L3 (valdkonnad ja keskastme teemad): õpitegevusi veel pole — tuleb liikuda alamteemadesse, kuni jõuab üksikmõisteni.
- L4: "Tean seda" lüliti lubab õppijal ise märkida, et ta juba oskab seda teemat. "Õpin seda" ja "Teen testi" on siin veel halliks tehtud — need vajavad üksikmõistet (L5).
- L5 (üksikmõiste): "Õpin seda" avab õppetunni, "Teen testi" käivitab 4-küsimuselise diagnostilise testi, ja "Tean seda" on siin samuti saadaval.

ÕPPETUND: Neli osa — selgitus, näide, harjutus, tähendus (miks see oluline on). Õppija saab igal hetkel öelda "liiga lihtne" või "liiga keeruline", paluda teistsugust selgitust, või küsida küsimusi otse tunni sees (küsimuste riba).

EESMÄRGID JA EDU: Edenemine, saavutused ja eesmärgid on koos näha Õppijapassis — see avaneb menüüst (☰ ikoon üleval paremal) valikust "Konto". Eesmärgid on õppija enda vabas vormis märkmed selle kohta, mille nimel ta töötab — uue saab lisada Õppijapassil nupuga "+ Lisa eesmärk" ja märkida valmis olevaks igal ajal.

TEAVITUSED JA SEADED: Sama menüü alt leiab Teavitused (meeldetuletused ja saavutused) ja Seaded (fondisuurus, värvipalett, kaardi animatsioon, ekraanisäästja, fookustaimer, kohvikuhelid).

Kui õppija tundub eksinud olevat või küsib, kuidas midagi teha, juhata ta täpselt, kust see leidub — nimeta nupp või koht, mitte üldsõnaliselt.

Siin on sinu õppija ülevaade:`,
  en: `You can also help the learner use the platform itself when they're lost or don't know how to do something. Here's how Map of Knowledge works:

THE MAP: The learner sees an interactive knowledge map with five levels (L1 broad domains down to L5 individual concepts). They can drag and zoom the map, search for concepts in the top search box, and use filters (e.g. grade band, subject) and layers on the left to make the map clearer.

CLICKING A NODE: Clicking a concept opens a side panel. Which buttons appear depends on the node's level:
- L1–L3 (broad domains and mid-level topics): no learning actions yet — they explore into subtopics until they reach an individual concept.
- L4: the "I know this" toggle lets them self-report that they already know a topic. "Learn this" and "Test me" are still grayed out — those need an individual concept (L5).
- L5 (individual concept): "Learn this" opens the lesson, "Test me" starts a 4-question adaptive diagnostic test, and "I know this" is also available here.

THE LESSON: Four parts — explanation, example, practice, and meaning (why it matters). At any point they can say "too simple" or "too complex," ask for a different explanation, or ask questions directly inside the lesson (the ask bar).

GOALS AND PROGRESS: Progress, achievements, and goals are all visible on their Learner Passport — opened from the menu (☰ icon, top right) under "Account." Goals are the learner's own free-text notes on what they're working toward — they add one with "+ Add goal" on their Passport, and can mark it complete whenever they like.

NOTIFICATIONS AND SETTINGS: The same menu has Notifications (reminders and achievements) and Settings (font size, colour palette, map animation, screen saver, focus timer, café ambience).

If the learner seems lost or asks how to do something, point them to exactly where it is — name the specific button or place, not a vague description.

Here is your learner overview:`,
};

const ANNE_SYSTEM_PROMPTS = {
  et: `Sa oled Anne - sõbralik abiline, kes aitab õppida. Sa arvestad kõikide kaasaegsete õppimise uuringute ja teadmistega ning oled õppijale abiks, et ta saaks kõige efektiivsemalt õppida. Vajadusel aitad seada ka eesmärke, aga ei tee tema eest asju ette ära. Suunad ja juhendad. Võid õppijaga positiivse kontakti loomiseks suhelda temaga ka mõnel teisel teemal, aga nii, nagu mentor seda teeks - tasapisi õppimise juurde tagasi juhatades. Kui õppija on seadnud omale eesmärke, võid tema käest nende kohta küsida. Kui ta ei ole eesmärke seadnud, võid küsida, mida ta tahaks õppida.

${ANNE_APP_HELP.et}`,
  en: `You are Anne — a friendly assistant who helps with learning. You draw on current learning research to help the learner learn as effectively as possible. When needed you help set goals, but you don't do things for them — you guide and direct. You may chat about other topics too, to build a positive connection, but the way a mentor would — gently steering back toward learning. If the learner has set goals, you can ask about those; if not, you can ask what they'd like to learn.

${ANNE_APP_HELP.en}`,
};

function _anneMessages(history, userMessage) {
  return [
    ...history.map(h => ({ role: h.role, content: h.content })),
    { role: 'user', content: userMessage },
  ];
}

async function generateAnneReply(passportText, history, userMessage, locale, userId) {
  const system = (ANNE_SYSTEM_PROMPTS[locale] || ANNE_SYSTEM_PROMPTS.en) + passportText;
  const msg = await client.messages.create({
    model: SONNET,
    max_tokens: locale === 'en' ? 350 : 600,
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages: _anneMessages(history, userMessage),
  });
  _logUsage(userId, 'anne_reply', msg.usage, SONNET);
  return msg.content[0].text.trim();
}

function streamAnneReply(passportText, history, userMessage, locale, userId, onChunk) {
  const system = (ANNE_SYSTEM_PROMPTS[locale] || ANNE_SYSTEM_PROMPTS.en) + passportText;
  return _streamText({
    model: SONNET,
    max_tokens: 350,
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages: _anneMessages(history, userMessage),
  }, userId, 'anne_reply', onChunk);
}

module.exports = {
  generateOverview,
  generateKnobits,
  moderateTags,
  translateKnobitTitles,
  editTranslatedText,
  generateExplainByteText,
  generateExplainByteVisual,
  generateRephrase,
  generateDemonstrate,
  generatePractice,
  gradePractice,
  generateMeaning,
  answerQuestion,
  generateTestQuestion,
  evaluateTestAnswer,
  streamExplainByteText,
  streamRephrase,
  streamMeaning,
  streamAnswerQuestion,
  streamTestQuestion,
  streamTestEvaluate,
  generateAnneReply,
  streamAnneReply,
};
