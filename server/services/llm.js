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

// Each round trip through the tool-use loop is its own billed API call, but
// only the FINAL response was ever returned — callers logging resp.usage were
// missing every intermediate search-turn's tokens. Accumulate across all
// turns and report the total on the returned response.
async function _callWithWebSearch(config) {
  const messages = [...config.messages];
  let totalInput = 0, totalOutput = 0;
  // Adds resp's own usage to the running total exactly once, then stamps the
  // total (so far) onto resp.usage — call once per resp, at most one of
  // these two per loop iteration.
  const tally = (resp) => {
    totalInput  += resp.usage?.input_tokens  || 0;
    totalOutput += resp.usage?.output_tokens || 0;
    resp.usage = { input_tokens: totalInput, output_tokens: totalOutput };
    return resp;
  };
  for (let i = 0; i < 5; i++) {
    const resp = await client.messages.create({ ...config, messages });
    if (resp.stop_reason !== 'tool_use') return tally(resp);
    tally(resp);
    messages.push({ role: 'assistant', content: resp.content });
    const results = resp.content
      .filter(b => b.type === 'tool_use')
      .map(b => ({ type: 'tool_result', tool_use_id: b.id, content: 'No results.' }));
    if (!results.length) return resp;
    messages.push({ role: 'user', content: results });
  }
  return tally(await client.messages.create({ ...config, messages }));
}

// Generic non-streaming tool-use loop: calls toolExecutor(name, input) for
// each tool_use block Claude emits, feeds the result back, and repeats until
// Claude stops calling tools (or MAX_TURNS is hit — a well-behaved tool
// shouldn't need more than 1-2 round trips). Returns the final text only.
async function _createWithTools(config, tools, toolExecutor, userId, callType) {
  const messages = [...config.messages];
  const MAX_TURNS = 4;
  let totalInput = 0, totalOutput = 0;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const resp = await client.messages.create({ ...config, messages, tools });
    totalInput += resp.usage?.input_tokens || 0;
    totalOutput += resp.usage?.output_tokens || 0;

    if (resp.stop_reason !== 'tool_use') {
      _logUsage(userId, callType, { input_tokens: totalInput, output_tokens: totalOutput }, config.model);
      const textBlock = resp.content.find(b => b.type === 'text');
      return textBlock ? textBlock.text : '';
    }

    messages.push({ role: 'assistant', content: resp.content });
    const toolResults = [];
    for (const b of resp.content.filter(b => b.type === 'tool_use')) {
      let result;
      try { result = await toolExecutor(b.name, b.input); }
      catch (err) { result = `Tool error: ${err.message}`; }
      toolResults.push({ type: 'tool_result', tool_use_id: b.id, content: String(result) });
    }
    messages.push({ role: 'user', content: toolResults });
  }
  _logUsage(userId, callType, { input_tokens: totalInput, output_tokens: totalOutput }, config.model);
  return ''; // exhausted MAX_TURNS without a final text answer — shouldn't happen in practice
}

// Streaming counterpart to _createWithTools: forwards only text_delta events
// to onChunk (tool-call JSON is never shown to the learner), accumulates
// tool_use input via input_json_delta per Anthropic's documented streaming
// pattern, then — once a turn's stop_reason is 'tool_use' — resolves every
// tool call and starts a fresh stream for the next turn. Retries a turn
// silently on a connection drop, but only while nothing has reached the
// caller's onChunk yet, same rule _streamText uses for the same reason
// (recurring "Premature close" on this host — see _streamText's comment).
async function _streamTextWithTools(config, tools, toolExecutor, userId, callType, onChunk) {
  const messages = [...config.messages];
  const MAX_TURNS = 4;
  let totalInput = 0, totalOutput = 0;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const MAX_ATTEMPTS = 3;
    let stopReason = null;
    let blocks = [];

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let emittedAny = false;
      blocks = [];
      try {
        const stream = await client.messages.create({ ...config, messages, tools, stream: true });
        for await (const event of stream) {
          if (event.type === 'content_block_start') {
            blocks[event.index] = event.content_block.type === 'tool_use'
              ? { type: 'tool_use', id: event.content_block.id, name: event.content_block.name, inputJson: '' }
              : { type: 'text', text: '' };
          } else if (event.type === 'content_block_delta') {
            const b = blocks[event.index];
            if (event.delta.type === 'text_delta') {
              emittedAny = true;
              b.text += event.delta.text;
              onChunk(event.delta.text);
            } else if (event.delta.type === 'input_json_delta') {
              b.inputJson += event.delta.partial_json;
            }
          } else if (event.type === 'message_start' && event.message?.usage) {
            totalInput += event.message.usage.input_tokens || 0;
          } else if (event.type === 'message_delta') {
            if (event.usage) totalOutput += event.usage.output_tokens || 0;
            if (event.delta?.stop_reason) stopReason = event.delta.stop_reason;
          }
        }
        break;
      } catch (err) {
        if (emittedAny || attempt === MAX_ATTEMPTS) throw err;
        console.error(`[anne stream] attempt ${attempt}/${MAX_ATTEMPTS} failed before any output (${err.message}) — retrying silently`);
      }
    }

    const toolUses = blocks.filter(b => b && b.type === 'tool_use');
    if (stopReason !== 'tool_use' || !toolUses.length) {
      _logUsage(userId, callType, { input_tokens: totalInput, output_tokens: totalOutput }, config.model);
      return;
    }

    const assistantContent = blocks.filter(Boolean).map(b =>
      b.type === 'tool_use'
        ? { type: 'tool_use', id: b.id, name: b.name, input: _safeParseToolJSON(b.inputJson) }
        : { type: 'text', text: b.text }
    );
    messages.push({ role: 'assistant', content: assistantContent });

    const toolResults = [];
    for (const b of toolUses) {
      let result;
      try { result = await toolExecutor(b.name, _safeParseToolJSON(b.inputJson)); }
      catch (err) { result = `Tool error: ${err.message}`; }
      toolResults.push({ type: 'tool_result', tool_use_id: b.id, content: String(result) });
    }
    messages.push({ role: 'user', content: toolResults });
  }
  _logUsage(userId, callType, { input_tokens: totalInput, output_tokens: totalOutput }, config.model);
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

// ── Loot Box — further learning resources, opened from the learning-path back
//    button. Search-heavy (6 of 9 categories need a live URL) — always called
//    through the /api/learn/lootbox cache, never per view. ─────────────────
const LOOTBOX_KEYS     = ['animation', 'play_a_game', 'treasure_map', 'podcast', 'ancient_scroll', 'breaking_news', 'fun_fact', 'time_machine', 'influencer', 'hack_it'];
const LOOTBOX_URL_KEYS = ['animation', 'play_a_game', 'treasure_map', 'podcast', 'ancient_scroll', 'breaking_news', 'influencer'];

function _langNameFor(locale) {
  if (!locale || locale === 'en') return 'English';
  return LANG_NAMES[locale] || locale;
}

async function generateLootBox(nodeLabel, breadcrumb, locale, userId) {
  const langName = _langNameFor(locale);
  const prompt = `You are a resource scout for Map of Knowledge, a learning environment. A learner is working through a node on a learning path. Your job is to fill a "Loot Box" — optional extra material that sits alongside the main lesson, in ten fixed categories.

Topic: ${nodeLabel} Where it sits: ${breadcrumb} Learning language: ${langName}

The learner is encountering this topic for the first time — pitch everything as an introduction, not as material for someone who already knows the subject.

The single most important rule

An empty slot is a good outcome. A wrong, dead, generic, or invented item is a bad one, and it is worse than nothing, because it teaches the learner that the Loot Box is not worth opening. Never pad. Never fabricate a URL. Never guess at a title you are not sure exists. If nothing clears the bar for a category, omit that category entirely.

Two kinds of category

Seven categories are retrieval: they need a real, live, specific URL. Search for these. Do not produce a URL from memory — URLs from memory are frequently wrong or dead. If your searches do not return something that clears the bar, omit the category.

Categories 7, 8 and 10 are generation: you write them yourself. No URL is required. These will almost always be fillable, so the Loot Box is rarely empty even when search goes badly. But they must be factually correct — search to verify any date, name, or claim you are not certain of, and drop any detail you cannot confirm.

Specificity bar

Every item must be about ${nodeLabel} specifically, not about ${breadcrumb} in general. If the topic is "semantics", a good general introduction to linguistics does not qualify. If the topic is "eigenvalues", a channel that covers all of linear algebra does not qualify unless you can point at the specific video. When you cannot find something topic-specific, omit — do not substitute something broader and hope it passes.

Prefer: free and un-paywalled, still online, well regarded, and accessible to someone new to the topic. Avoid: content farms, SEO listicles, AI-generated slop, anything requiring an account, anything you only half-recognise.

Language

Prefer material in ${langName}. Search in that language first, using native search terms rather than translated English ones.

If ${langName} is a smaller language, good material may simply not exist for this topic — that is expected. In that case English material is acceptable; mark it with "lang" so the app can label it. Never prefer a weak resource in ${langName} over a strong one in English. Quality first, language second.

Special case: if ${nodeLabel} is itself a language being learned, ${langName} is the language of instruction, not the target. Resources about the target language should be in ${langName}; resources that are examples of the target language (a podcast for listening practice, a story to read) should be in the target language and pitched at a beginner in that language.

The ten categories

1. Animation — retrieval. A YouTube animation or explainer video. Wants visual explanation, not a lecture recording of someone talking at a whiteboard for 50 minutes. Under ~25 minutes. Check upload date and view count in results; a video with 40 views from an abandoned channel is usually not the one. Best for anything with a mechanism, a process, or a spatial structure.

2. Play a Game — retrieval. A browser game, simulation, or interactive toy. Must be playable now, free, and no download. Interactive visualisations and sandboxes count. A quiz app does not — that is drilling, not play. This category is genuinely empty for most topics. Fill it when a real one exists and skip it otherwise.

3. Treasure Map — retrieval. A Google Maps or OpenStreetMap link to a place that matters to the topic: where something was discovered, a distribution, a site, a route. Only when geography carries actual meaning. For most abstract topics — most of maths, logic, and theory — there is no such place, and this should be empty rather than a stretched connection to a university building.

4. Podcast — retrieval. A specific episode, not a whole show, unless the show is entirely about ${nodeLabel}. Link to Spotify, the show's own page, or wherever it is publicly hosted.

5. Ancient Scroll — retrieval. One book: popular science, a classic text, a memoir, or fiction that treats the topic seriously. Give author and year. Verify it exists and that the author is right — misattributed books are a common failure. Link to a publisher page, a library record, or Goodreads; no affiliate links. If a short, readable primary source exists — an original paper or essay of a few pages — that is often a better pick than a 400-page overview, and can go here.

6. In the News — retrieval. A genuinely recent news story — ideally from the last few months, at most the last couple of years — about ${nodeLabel} specifically, or about a very closely related development if nothing exists on the exact topic itself. Search real news sources: established outlets, wire services, dedicated science/tech press. Not blogs, press-release mills, or SEO content farms. The story must be substantively about the topic, not a passing mention in an article about something else. If nothing recent and genuinely on-topic exists, omit — most topics will not have current news coverage at any given moment, and that is the expected, common case, not a failure. Give the outlet name and a rough publication date, and link directly to the article.

7. Fun Fact — generation. Two to four sentences. A surprising fact, an origin story, a good argument between two researchers, a wrong idea people held for a long time. It must be true and it must be about ${nodeLabel} specifically. Search to check anything you are not certain of. Discard anything that smells like a widely repeated myth. No "scientists were baffled" framing — just tell it.

8. Time Machine — generation. Four to seven dated entries, chronological, one line each. Include at least one entry that is a wrong turn, an abandoned idea, or a dispute — those are what make a timeline memorable rather than a list. Every date must be one you are confident in; drop the entry rather than approximate. If the topic has no meaningful history, omit the whole category. Also write a "prologue": one line dated to clearly before your earliest entry, saying that ${nodeLabel} — as a concept, field, or practice — simply didn't exist or wasn't understood yet. Pick a distance that fits the timeline's own scale (decades before a 20th-century timeline, centuries before an ancient one) — it only needs to feel like "before the story starts," not be precise. Omit the prologue only in the rare case where your earliest entry already is the origin of the concept itself (its invention, discovery, or coining), since there is nothing true to say about "before" then.

And a "future": one line looking past your latest entry, at an open question, an active research direction, or a hoped-for-but-not-yet-achieved result specific to ${nodeLabel}. Search to check this is a real, currently active direction — not something already resolved, and not something you invented. Hedge appropriately ("still unresolved," "researchers are working on," "one open question is") rather than stating a confident prediction; a made-up-sounding forecast is worse than omitting this. Omit the future entry entirely if the topic is genuinely closed (a settled historical event, a fixed mathematical fact) with no real open question left to point at.

9. Influencer — retrieval. One living person actively producing work a learner can follow: a researcher, writer, teacher, or channel. Name them, say in one line what they do and why they are worth following, and link to where their output actually appears — their channel, blog, or site, not a Wikipedia article. Prefer someone specific to ${nodeLabel} over a general science-communication celebrity. Say nothing about them beyond their public professional work.

10. Hack It — generation. One concrete project doable in an evening or a weekend with things a normal person has: a computer, a phone, a notebook, household objects, free software. State the outcome first, then 3–6 steps, then what the learner will have noticed or built by the end. It must produce a result the learner can look at. "Read about X and reflect" is not a project. For abstract topics, good shapes are: collect and analyse a small data set, build a tiny working model, run a self-experiment, or apply the idea to something the learner already has.

Output

Return ONLY a single JSON object — no markdown fences, no commentary outside the JSON. Omit the key entirely for any category that doesn't clear the bar; do not include it with a null or empty value. Use exactly these keys:

{
  "animation":      { "title": "...", "url": "...", "note": "one short line on what makes it worth watching", "lang": "en"|"${langName}" },
  "play_a_game":    { "title": "...", "url": "...", "note": "...", "lang": "..." },
  "treasure_map":   { "title": "...", "url": "...", "note": "one line on why this place matters to the topic", "lang": "..." },
  "podcast":        { "title": "...", "url": "...", "note": "episode/show name and why it's the pick", "lang": "..." },
  "ancient_scroll": { "title": "...", "author": "...", "year": 1999, "url": "...", "note": "...", "lang": "..." },
  "breaking_news":  { "title": "...", "source": "...", "date": "...", "url": "...", "note": "one line on why this is relevant right now", "lang": "..." },
  "fun_fact":       { "text": "2-4 sentences" },
  "time_machine":   { "prologue": { "era": "one short label for the before-time, e.g. 'Before 1850'", "text": "one line on ${nodeLabel} not existing/being understood yet" }, "entries": [ { "date": "...", "text": "one line" }, ... ], "future": { "era": "one short label, e.g. 'Looking ahead'", "text": "one line on an open question or active research direction" } },
  "influencer":     { "name": "...", "role": "one line on what they do and why worth following", "url": "..." },
  "hack_it":        { "outcome": "what the learner will end up with", "steps": [ "...", "..." ], "result": "what they'll have noticed or built by the end" }
}

"lang" on the seven retrieval categories: omit it when the resource is in ${langName}; set it to "en" only when you had to fall back to English material per the Language section above.

Before you return

Check: does every URL come from a search result in this session, or was any assembled from memory? Is every item about ${nodeLabel} rather than its parent field? Is anything included only because the slot existed?`;

  const resp = await _callWithWebSearch({
    model: SONNET,
    max_tokens: 3000,
    tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    system: [{ type: 'text', text: 'You are a meticulous resource scout. Respond only with the JSON object requested — no markdown fences, no commentary.', cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: prompt }],
  });

  _logUsage(userId, 'lootbox', resp.usage, SONNET);

  const fullText = resp.content.filter(b => b.type === 'text').map(b => b.text).join('');
  if (!fullText) return {};

  let result;
  try {
    result = _extractJSON(fullText);
  } catch {
    return {};
  }

  const out = {};
  for (const key of LOOTBOX_KEYS) {
    if (result && result[key] && typeof result[key] === 'object') out[key] = result[key];
  }
  return out;
}

// ── Anne — persistent mentor chat widget ──────────────────────────────────────
// ANNE_APP_HELP: plain-language reference to the app's actual UI, so Anne can
// answer "how do I..." questions and guide a lost learner, not just coach on
// study habits. Keep this in sync when learner-facing UI changes — it's a
// static block, not derived from the code, so it goes stale silently.
// Gamification (lumens/rank/streaks/achievements/leaderboard) shipped and is
// covered below — the earlier note here saying to omit it is stale.
// Loot Box category names and achievement medal names are NOT translated
// (bypass the i18n layer entirely, always render in English regardless of
// locale) — kept in English in the 'et' block below for the same reason.
const ANNE_APP_HELP = {
  et: `Sa oskad õppijat aidata ka platvormi kasutamisel, kui ta on eksinud või ei tea, kuidas midagi teha. Nii Map of Knowledge töötab:

KAART: Õppija näeb interaktiivset teadmiste kaarti viie tasemega (L1 valdkonnad kuni L5 üksikmõisted). Kaarti saab lohistada ja suumida, mõisteid otsida ülal otsingukastist (vaikimisi kitsas, laieneb fookuse peale), ning kasutada vasakul filtreid (nt põhikool/gümnaasium, aine) ja kihte, et kaarti selgemaks muuta.

SÕLME KLIKKIMINE: Kui õppija klikib mõistel, avaneb külgpaneel. Nupud sõltuvad mõiste tasemest:
- L1–L3 (valdkonnad ja keskastme teemad): õpitegevusi veel pole — tuleb liikuda alamteemadesse, kuni jõuab üksikmõisteni.
- L4: "Tean seda" lüliti lubab õppijal ise märkida, et ta juba oskab seda teemat. "Õpin seda" ja "Teen testi" on siin veel halliks tehtud — need vajavad üksikmõistet (L5).
- L5 (üksikmõiste): "Õpin seda" avab õppetunni, "Teen testi" käivitab 4-küsimuselise diagnostilise testi, ja "Tean seda" on siin samuti saadaval.

ÕPPETUND: Neli osa — selgitus, näide, harjutus, tähendus (miks see oluline on). Õppija saab igal hetkel öelda "liiga lihtne" või "liiga keeruline", paluda teistsugust selgitust, või küsida küsimusi otse tunni sees (küsimuste riba). Õpiraja vaates (tunni juures) on nupp mõiste nime kõrval, mis avab "Loot Box" — täiendavate õppematerjalide komplekti selle konkreetse teema jaoks: video ("Animation"), mäng ("Play a Game"), teemaga seotud päris koht ("Treasure Map"), taskuhäälingu osa ("Podcast"), raamat ("Ancient Scroll"), värske uudis teemal ("In the News"), põnev fakt ("Fun Fact"), ajajoon ("Time Machine"), kellegi jälgimiseks ("Influencer") ja käed-külge projekt ("Hack It"). Mitte igal teemal pole kõiki kümmet — näidatakse ainult neid, mis päriselt sobivad; osad avanevad uues vahekaardis, kolm kirjutatud kategooriat (Fun Fact, Time Machine, Hack It) avanevad samas aknas.

EESMÄRGID JA EDU: Edenemine ja eesmärgid on koos näha Õppijapassis — see avaneb menüüst (☰ ikoon üleval paremal) valikust "Konto". Eesmärgid on õppija enda vabas vormis märkmed selle kohta, mille nimel ta töötab — uue saab lisada Õppijapassil nupuga "+ Lisa eesmärk" ja märkida valmis olevaks igal ajal.

IQUEST (MÄNGulisus): Õppijapassi 8. lõik, "IQuest". Neli töötavat kaarti:
- Seeria (streak): iga päev, mil õppija lõpetab vähemalt ühe knobiti, loetakse (tema enda kohalik päev, kesköö kuni kesköö) — lumenid seda ei mõjuta. Kui terve päev vahele jääb, seeria katkeb, välja arvatud kui õppijal on Streak Saver, mida kasutatakse automaatselt seeria kaitsmiseks. Streak Saveri (kuni 3 korraga) teenib, lõpetades terve teema kõik knobitid 24 tunni jooksul. Kuvatakse ka seni pikim seeria. Väike leegi-ikoon otsingukasti kõrval üleval reageerib — süttinud, kui seeria on aktiivne — ja klõps viib otse siia kaardi juurde.
- Lumens & Rank: lumeneid teenib knobiti lõpetamisega (+10), terve teema lõpetamisega (+25 juurde), terve suurema üksuse lõpetamisega (+100 juurde), teadmiste testi sooritamisega olenemata tulemusest (+10), refleksiooni kirjutamisega (+5) ja Õppijapassi profiili täitmisega ühekordselt (+10) — kõike korrutab hoo (momentum) kordaja, mis kasvab, mida järjepidevamalt õppija õpib (see EI ole seotud eelmise seeriaga — eraldi mehaanika). Tase (rank) tõuseb redelil kogutud lumenite põhjal.
- Achievements: 13 medalit verstapostide eest (esimene knobit, täiuslik testitulemus, õppimine ebatavalisel kellaajal, terve valdkonna omandamine, esimese refleksiooni kirjutamine, esimene vestlus sinuga endaga, esimese eesmärgi seadmine/täitmine ja rohkem) — "i" nupp näitab täpselt, mida iga medal nõuab.
- Leaderboard: 5 parimat õppijat lumenite järgi, pluss oma koht, kui ise top 5-s ei ole.
Igal "i" ikooniga kaardil on oma hüpikaken täpse selgitusega — suuna õppija sinna täpsete numbrite jaoks, mitte ära korda neid ise peast, sest kui see tekst ja ekraanil olev hüpikaken kunagi lahknevad, on ekraanil olev õige.

TEAVITUSED JA SEADED: Sama menüü alt leiab Teavitused (meeldetuletused ja saavutused) ja Seaded (fondisuurus, värvipalett, kaardi animatsioon, ekraanisäästja, fookustaimer, kohvikuhelid).

Kui õppija tundub eksinud olevat või küsib, kuidas midagi teha, juhata ta täpselt, kust see leidub — nimeta nupp või koht, mitte üldsõnaliselt.

Siin on sinu õppija ülevaade:`,
  en: `You can also help the learner use the platform itself when they're lost or don't know how to do something. Here's how Map of Knowledge works:

THE MAP: The learner sees an interactive knowledge map with five levels (L1 broad domains down to L5 individual concepts). They can drag and zoom the map, search for concepts in the top search box (narrow by default, expands on focus), and use filters (e.g. grade band, subject) and layers on the left to make the map clearer.

CLICKING A NODE: Clicking a concept opens a side panel. Which buttons appear depends on the node's level:
- L1–L3 (broad domains and mid-level topics): no learning actions yet — they explore into subtopics until they reach an individual concept.
- L4: the "I know this" toggle lets them self-report that they already know a topic. "Learn this" and "Test me" are still grayed out — those need an individual concept (L5).
- L5 (individual concept): "Learn this" opens the lesson, "Test me" starts a 4-question adaptive diagnostic test, and "I know this" is also available here.

THE LESSON: Four parts — explanation, example, practice, and meaning (why it matters). At any point they can say "too simple" or "too complex," ask for a different explanation, or ask questions directly inside the lesson (the ask bar). On the learning-path screen (surrounding the lesson), a button next to the topic name opens the "Loot Box" — further-learning resources for that specific topic: a video (Animation), a game (Play a Game), a real place tied to the topic (Treasure Map), a podcast episode (Podcast), a book (Ancient Scroll), a recent news story (In the News), a fun fact (Fun Fact), a timeline (Time Machine), someone to follow (Influencer), and a hands-on project (Hack It). Not every topic has all ten — only ones that genuinely fit are shown; most open in a new tab, but the three written ones (Fun Fact, Time Machine, Hack It) open inside the same dialog.

GOALS AND PROGRESS: Progress and goals are visible on their Learner Passport — opened from the menu (☰ icon, top right) under "Account." Goals are the learner's own free-text notes on what they're working toward — they add one with "+ Add goal" on their Passport, and can mark it complete whenever they like.

IQUEST (GAMIFICATION): Section 8 of the Learner Passport, called "IQuest." Four live cards:
- Streak: one day counts whenever the learner completes at least one knobit (their own local day, midnight to midnight) — lumens don't affect it. Missing a full day breaks the streak unless they have a Streak Saver, which is used automatically to protect it. A Streak Saver (max 3 held) is earned by finishing every knobit in a whole topic within 24 hours. Longest-ever streak is shown too. A small flame icon next to the search bar in the top bar reflects this — lit when there's an active streak — and links straight to this card.
- Lumens & Rank: lumens are earned by completing a knobit (+10), finishing an entire topic (+25 more), finishing everything under a bigger unit (+100 more), completing a knowledge test regardless of score (+10), writing a reflection (+5), and completing their Learner Passport profile once (+10) — all scaled up by a momentum multiplier that climbs the more consistently they learn (this is unrelated to the streak above — a separate mechanic). Rank climbs a ladder based on total lumens.
- Achievements: 13 medals for milestones (first knobit, a perfect test score, studying at unusual hours, mastering a whole subject area, writing their first reflection, their first chat with you, setting/completing their first goal, and more) — tap the "i" for the exact criteria for each one.
- Leaderboard: top 5 learners by lumens, plus their own position if they're not in the top 5.
Every card with an "i" icon has its own popover explaining exactly how it works — point them there for specifics rather than reciting numbers from memory, since if this text and the on-screen popover ever drift, the on-screen one is the accurate one.

NOTIFICATIONS AND SETTINGS: The same menu has Notifications (reminders and achievements) and Settings (font size, colour palette, map animation, screen saver, focus timer, café ambience).

If the learner seems lost or asks how to do something, point them to exactly where it is — name the specific button or place, not a vague description.

Here is your learner overview:`,
};

const ANNE_SYSTEM_PROMPTS = {
  et: `Sa oled Anne - sõbralik abiline, kes aitab õppida. Sa arvestad kõikide kaasaegsete õppimise uuringute ja teadmistega ning oled õppijale abiks, et ta saaks kõige efektiivsemalt õppida. Vajadusel aitad seada ka eesmärke, aga ei tee tema eest asju ette ära. Suunad ja juhendad. Võid õppijaga positiivse kontakti loomiseks suhelda temaga ka mõnel teisel teemal, aga nii, nagu mentor seda teeks - tasapisi õppimise juurde tagasi juhatades. Kui õppija on seadnud omale eesmärke, võid tema käest nende kohta küsida. Kui ta ei ole eesmärke seadnud, võid küsida, mida ta tahaks õppida.

Sul on tööriist "search_map", millega saad otsida Map of Knowledge kaardilt (kõik tasemed L1-L5). Kasuta seda alati, kui õppija küsib midagi, mis eeldab teadmist, kas ja kus mingi teema kaardil olemas on, või palub teemasoovitusi mingis valdkonnas — ära arva ega väida vastust ilma otsimata.

${ANNE_APP_HELP.et}`,
  en: `You are Anne — a friendly assistant who helps with learning. You draw on current learning research to help the learner learn as effectively as possible. When needed you help set goals, but you don't do things for them — you guide and direct. You may chat about other topics too, to build a positive connection, but the way a mentor would — gently steering back toward learning. If the learner has set goals, you can ask about those; if not, you can ask what they'd like to learn.

You have a "search_map" tool that searches the actual Map of Knowledge (every level, L1-L5). Use it whenever the learner asks something that depends on knowing whether/where a topic exists on the map, or asks for topic suggestions in some area — don't guess or answer from assumption without searching first.

${ANNE_APP_HELP.en}`,
};

const SEARCH_MAP_TOOL = {
  name: 'search_map',
  description: 'Search the Map of Knowledge\'s topic map by keyword or phrase, across all five levels (L1 broad domains down to L5 individual concepts). Returns matching topics with their level and full breadcrumb path. Use this whenever answering requires knowing whether, or where, something exists on the map.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Keyword or short phrase to search for, e.g. "photosynthesis" or "linear equations". Write it in the learner\'s own language.' },
    },
    required: ['query'],
  },
};

function _safeParseToolJSON(raw) {
  try { return JSON.parse(raw || '{}'); } catch { return {}; }
}

function _anneMessages(history, userMessage) {
  return [
    ...history.map(h => ({ role: h.role, content: h.content })),
    { role: 'user', content: userMessage },
  ];
}

function _anneSystem(passportText, locale) {
  return [{
    type: 'text',
    text: (ANNE_SYSTEM_PROMPTS[locale] || ANNE_SYSTEM_PROMPTS.en) + passportText,
    cache_control: { type: 'ephemeral' },
  }];
}

function _anneToolExecutor(locale) {
  const { searchMapNodes } = require('./mapSearch');
  return async (name, input) => {
    if (name === 'search_map') return searchMapNodes(input && input.query, locale);
    return `Unknown tool: ${name}`;
  };
}

async function generateAnneReply(passportText, history, userMessage, locale, userId) {
  const text = await _createWithTools({
    model: SONNET,
    max_tokens: locale === 'en' ? 350 : 600,
    system: _anneSystem(passportText, locale),
    messages: _anneMessages(history, userMessage),
  }, [SEARCH_MAP_TOOL], _anneToolExecutor(locale), userId, 'anne_reply');
  return text.trim();
}

function streamAnneReply(passportText, history, userMessage, locale, userId, onChunk) {
  return _streamTextWithTools({
    model: SONNET,
    max_tokens: 350,
    system: _anneSystem(passportText, locale),
    messages: _anneMessages(history, userMessage),
  }, [SEARCH_MAP_TOOL], _anneToolExecutor(locale), userId, 'anne_reply', onChunk);
}

// ── Knowledge estimation from qualifications ────────────────────────────────
// Two-pass design, validated against real map data before being built into
// the product (see docs/orientation.md's "Knowledge estimation" section):
// pass 1 does a cheap scan across L4 topic areas (~1700 nodes) to find broad
// candidates; pass 2 fetches only the L5 CHILDREN of those candidates and
// judges leaf-by-leaf plausibility + retention tier. Matching at L4 alone and
// blanket-applying to every L5 child was tried and rejected — an L4 node's
// children are sometimes themselves specialized sub-topics (e.g. "Islam"'s
// only children ARE its specific denominations), so a coarse "shallow survey"
// match at L4 doesn't safely cascade down without a leaf-level plausibility
// check landing at the same granularity where the write actually happens.
const CURRICULUM_GUIDANCE = `- Broad general-education qualifications (e.g. secondary school diplomas) can reasonably cover MANY areas across many top-level subjects — a multi-year general education genuinely does cover a wide range, even if shallowly and now partly forgotten. Don't under-match these out of caution.
- Infer the country/education system from the issuer (e.g. an Estonian institution implies the Estonian national curriculum) and judge plausibility against what that system would typically teach at that level.
- Specialized qualifications (a degree, a vocational/technical certification) should match narrowly and precisely.
- A short introductory course (check any provided duration/format details) covers far less ground than a multi-year program, regardless of recency.`;

function _qualificationLines(qualifications) {
  return qualifications.map((q, i) =>
    `${i + 1}. "${q.title}" — ${q.issuer || 'unknown issuer'}, ${q.year}${q.details ? ` (${q.details})` : ''}`
  ).join('\n');
}

// Pass 1 — qualifications x L4 breadcrumb list -> candidate L4 areas per qualification.
async function estimateKnowledgeAreas(qualifications, l4List, userId) {
  const system = `You estimate a learner's baseline familiarity with topics in a knowledge map, based on formal qualifications they've completed. You'll be given qualifications and a list of Level-4 topic areas (id + full breadcrumb).

Identify which topic areas each qualification would plausibly give someone baseline familiarity with (be broad/generous for general education, narrow/precise for specialized qualifications).
${CURRICULUM_GUIDANCE}

Respond with ONLY minified JSON: {"results":[{"qualification":"<title verbatim>","matches":[{"id":"<external_id>","confidence":<0-100>,"why":"<3-8 word reason>"}]}]}`;

  const msg = await client.messages.create({
    model: SONNET,
    max_tokens: 8000,
    system,
    messages: [{ role: 'user', content: `QUALIFICATIONS:\n${_qualificationLines(qualifications)}\n\nL4 TOPIC AREAS (id, then full breadcrumb):\n${l4List}` }],
  });
  _logUsage(userId, 'knowledge_estimate_areas', msg.usage, SONNET);
  return _extractJSON(msg.content[0].text);
}

// Pass 2 — qualifications x their candidate L5 leaves (grouped by parent L4) ->
// final leaf-level matches, each with a confidence and a retention tier.
async function estimateKnowledgeLeaves(qualifications, perQualGroups, userId) {
  const system = `You previously identified broad topic AREAS each qualification plausibly touches. Now decide, leaf by leaf, which SPECIFIC topics within those areas the qualification would realistically cover — this is the actual depth that matters.
${CURRICULUM_GUIDANCE}

Critical: an area can be a good broad match while most of its specific leaves are still too deep/specialized for the qualification actually completed — e.g. a general secondary education's "world religions" survey covers major religions at an overview level, but NOT their internal denominations/sects (a specific school like Sufism or a specific branch like Shia Islam requires dedicated study, not a survey unit) — exclude those leaves even though the parent area (Islam) is a reasonable broad match. Apply this same "would a real course/programme at this depth actually teach this exact leaf-level thing" test to every leaf, in every subject, not just religion.

For each surviving leaf, also classify its RETENTION tier — how much time and disuse would erode this specific knowledge, independent of how long ago it was learned:
- "core": an automatized skill that gets constantly reinforced in ordinary adult life for almost everyone, regardless of career — basic arithmetic operations, native-language spelling/reading/grammar, telling time, everyday counting/money. These barely fade even decades later.
- "practiced": revisited occasionally in normal adult life (news, casual conversation, general awareness) but not used automatically every day — general history/geography facts, basic science concepts, civics. Fades meaningfully over years without reinforcement.
- "specialized": rarely revisited by anyone who doesn't work directly in that field after finishing the qualification — deep theorems, specific technical formulas, narrow doctrinal or theoretical detail, niche facts. Fades fastest.
A native language's spelling/grammar is "core"; the same skill in a foreign language learned but not used since is "practiced" at best. Most K-12/general-education leaves are "practiced" unless they're a rote skill drilled into automaticity (arithmetic tables, reading). Most degree/specialized-course leaves are "specialized" unless the field is one the person plausibly kept using daily (judge from the qualification itself, you don't know their career).

For each qualification you are given candidate leaves grouped by their matched parent area. Return ONLY the leaves that pass the plausibility test, each with a confidence 0-100 and a retention tier.

Respond with ONLY minified JSON: {"results":[{"qualification":"<title verbatim>","leaves":[{"id":"<external_id>","confidence":<0-100>,"retention":"core|practiced|specialized"}]}]}`;

  const userMsg = qualifications.map((q, i) => {
    const groups = perQualGroups[q.title] || [];
    const groupText = groups.map(g =>
      `  Area: ${g.crumb} (matched because: ${g.why})\n` +
      g.leaves.map(l => `    ${l.external_id}\t${l.label}`).join('\n')
    ).join('\n');
    return `${i + 1}. "${q.title}" — ${q.issuer || 'unknown issuer'}, ${q.year}${q.details ? ` (${q.details})` : ''}\n${groupText}`;
  }).join('\n\n');

  const msg = await client.messages.create({
    model: SONNET,
    max_tokens: 16000,
    system,
    messages: [{ role: 'user', content: userMsg }],
  });
  _logUsage(userId, 'knowledge_estimate_leaves', msg.usage, SONNET);
  return _extractJSON(msg.content[0].text);
}

// Percentage-by-retention-tier: retention isn't just a function of years --
// it's a function of how automatized the skill is. Multiplication tables get
// reinforced constantly for life; a chemistry formula from one course usually
// isn't. Validated interactively against real qualifications before being
// hardcoded — see docs/orientation.md.
const RETENTION_TIERS = {
  core:        { base: 95, halfLife: 60, floor: 85 },
  practiced:   { base: 80, halfLife: 10, floor: 15 },
  specialized: { base: 75, halfLife: 6,  floor: 10 },
};

function knowledgeEstimatePercentage(awardedYear, retentionTier) {
  const tier = RETENTION_TIERS[retentionTier] || RETENTION_TIERS.practiced;
  const yearsAgo = Math.max(0, new Date().getFullYear() - awardedYear);
  return Math.max(tier.floor, Math.round(tier.base * Math.pow(0.5, yearsAgo / tier.halfLife)));
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
  generateLootBox,
  LOOTBOX_URL_KEYS,
  estimateKnowledgeAreas,
  estimateKnowledgeLeaves,
  knowledgeEstimatePercentage,
};
