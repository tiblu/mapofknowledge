const Anthropic = require('@anthropic-ai/sdk');
const db        = require('../db');
const testlog   = require('../testlog'); // TESTLOG

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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
1. Search Wikimedia Commons for a relevant image. Return the Commons file page URL in the format
   https://commons.wikimedia.org/wiki/File:EXACT_FILENAME — never construct upload.wikimedia.org URLs yourself.
   Hard rule: reject any image with a visible copyright notice, watermark, company logo, or © mark.
   Only use YouTube if the concept specifically requires motion or animation to understand (e.g. a physical
   process, a technique, a demonstration) — not just because no Wikimedia image was found.
2. If nothing genuinely useful exists: set visual to null.`;

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
    text: `You are an expert adaptive tutor inside the KnoBitz learning platform.
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
async function generateKnobits(nodeLabel, domain, breadcrumb) {
  const msg = await client.messages.create({
    model: SONNET,
    max_tokens: 600,
    system: [{
      type: 'text',
      text: `You are a curriculum designer for the KnoBitz platform.
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

Typically 5–12 knobits, progressing from foundational to nuanced.`,
    }],
  });
  return parseJSON(msg.content[0].text.trim());
}

// ── Knobit title translation ──────────────────────────────────────────────────
async function translateKnobitTitles(knobits, targetLocale) {
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
  const translated = parseJSON(msg.content[0].text.trim());
  return knobits.map((k, i) => ({ ...k, title: (Array.isArray(translated) && translated[i]) || k.title }));
}

// ── Explain phase — text only (fast, no web search) ──────────────────────────
async function generateExplainByteText(nodeLabel, knobitTitle, byteIndex, previousContent, locale, profile, userId) {
  let prompt;
  if (byteIndex === 0 || !previousContent) {
    prompt = `Teaching knobit "${knobitTitle}" within topic "${nodeLabel}".

Write the OPENING explanation (byte 1). Introduce the core concept clearly and simply.
2–4 sentences. Plain prose — no headings, no bullet points. Plain text only, no HTML tags. Use \\n for line breaks.${profileBlock(profile)}${langText(locale)}`;
  } else {
    prompt = `Teaching knobit "${knobitTitle}" within topic "${nodeLabel}".

Previous explanation the learner understood:
"""
${previousContent}
"""

Write the NEXT step (byte ${byteIndex + 1}). Cover a new aspect or go one level deeper. Do NOT repeat or paraphrase what was already explained.
2–4 sentences. Plain prose — no headings, no bullet points. Plain text only, no HTML tags. Use \\n for line breaks.${profileBlock(profile)}${langText(locale)}`;
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
Rewrite it with professional, expert-level language. Use precise terminology,
a more formal framing, and the kind of depth an expert or researcher would appreciate.
Same core concept — elevated register.`,

    complex: `The learner found this too complex.
Rewrite using the simplest possible words. STRICT rules: every sentence must be at most 10 words long.
Maximum 3 sentences per paragraph. No jargon — replace every technical term with a plain everyday word.
Use one concrete real-life example (something a child could picture).
Same core concept — maximally accessible.`,
  }[mode] || 'Rewrite this explanation from a different angle.';

  const msg = await client.messages.create({
    model: SONNET,
    max_tokens: 200,
    system: TUTOR_SYSTEM,
    messages: [{
      role: 'user',
      content: `Topic: "${nodeLabel}" — Knobit: "${knobitTitle}"

Current explanation:
"""
${originalByte}
"""

${instructions}

Write the replacement paragraph only — 2–4 sentences, no headings.${profileBlock(profile)}${langText(locale)}`,
    }],
  });
  _logUsage(userId, 'rephrase', msg.usage, SONNET);
  return msg.content[0].text.trim();
}

// ── Demonstrate phase ─────────────────────────────────────────────────────────
async function generateDemonstrate(nodeLabel, knobitTitle, exampleIndex, locale, profile, userId) {
  const msg = await client.messages.create({
    model: SONNET,
    max_tokens: 350,
    system: TUTOR_SYSTEM,
    messages: [{
      role: 'user',
      content: `Topic: "${nodeLabel}" — Knobit: "${knobitTitle}"
Worked example number: ${exampleIndex + 1}

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
async function generatePractice(nodeLabel, knobitTitle, problemIndex, locale, profile, userId) {
  const difficulty = problemIndex === 0 ? 'straightforward' : problemIndex === 1 ? 'moderate' : 'challenging';
  const msg = await client.messages.create({
    model: SONNET,
    max_tokens: 250,
    system: TUTOR_SYSTEM,
    messages: [{
      role: 'user',
      content: `Topic: "${nodeLabel}" — Knobit: "${knobitTitle}"
Practice problem ${problemIndex + 1} — difficulty: ${difficulty}

Respond with valid JSON, two fields only:
- "question": the problem statement (1–3 sentences)
- "expected": the correct answer (brief — a number, term, or short phrase)

No markdown fences. Just the JSON object.${profileBlock(profile)}${langJson(locale)}`,
    }],
  });
  _logUsage(userId, 'practice', msg.usage, SONNET);
  return parseJSON(msg.content[0].text.trim());
}

// ── Grade a practice answer ───────────────────────────────────────────────────
async function gradePractice(nodeLabel, knobitTitle, question, expected, userAnswer, locale, userId) {
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
    max_tokens: 180,
    system: TUTOR_SYSTEM,
    messages: [{
      role: 'user',
      content: `Topic: "${nodeLabel}" — Knobit: "${knobitTitle}"

Write 2–3 sentences on why this matters in the real world.
Be concrete: name a profession, product, decision, or daily situation where it directly applies.
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
      text: `You are a focused learning assistant inside the KnoBitz platform.
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
async function generateTestQuestion(nodeLabel, breadcrumb, questionNum, history, locale, userId) {
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

  const _tqPrompt = `Topic: "${nodeLabel}" (${breadcrumb})\nTier ${questionNum}: ${tiers[questionNum - 1]}\n${adaptNote}\n${historyText ? `\nPrevious Q&A:\n${historyText}` : ''}\n\nGenerate question ${questionNum}. Choose open or MCQ based on what best tests this tier.\nFor MCQ: provide exactly 4 options, include correctIndex (0–3). Return JSON only.${langJson(locale)}`; // TESTLOG
  testlog('llm_question_prompt', { userId, nodeLabel, questionNum, prompt: _tqPrompt }); // TESTLOG

  const msg = await client.messages.create({
    model: SONNET,
    max_tokens: 400,
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
    messages: [{ role: 'user', content: _tqPrompt }],
  });

  const _tqRaw = msg.content[0].text.trim(); // TESTLOG
  testlog('llm_question_response', { userId, questionNum, raw: _tqRaw }); // TESTLOG
  _logUsage(userId, 'test_question', msg.usage, SONNET);
  return parseJSON(_tqRaw);
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

  const _teRaw = msg.content[0].text.trim(); // TESTLOG
  testlog('llm_evaluate_response', { userId, questionNum, raw: _teRaw }); // TESTLOG
  _logUsage(userId, 'test_evaluate', msg.usage, SONNET);
  return parseJSON(_teRaw);
}

// ── Text streaming (SDK 0.39.x: create({stream:true}) → Promise<Stream>) ───────
// Calls onChunk for each text token; resolves when the stream ends.
async function _streamText(config, userId, callType, onChunk) {
  const stream = await client.messages.create(Object.assign({}, config, { stream: true }));
  let inputTokens = 0, outputTokens = 0;
  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta && event.delta.type === 'text_delta') {
      onChunk(event.delta.text);
    } else if (event.type === 'message_start' && event.message && event.message.usage) {
      inputTokens = event.message.usage.input_tokens || 0;
    } else if (event.type === 'message_delta' && event.usage) {
      outputTokens = event.usage.output_tokens || 0;
    }
  }
  _logUsage(userId, callType, { input_tokens: inputTokens, output_tokens: outputTokens }, config.model);
}

function streamExplainByteText(nodeLabel, knobitTitle, byteIndex, previousContent, locale, profile, userId, onChunk) {
  let prompt;
  if (byteIndex === 0 || !previousContent) {
    prompt = `Teaching knobit "${knobitTitle}" within topic "${nodeLabel}".\n\nWrite the OPENING explanation (byte 1). Introduce the core concept clearly and simply.\n2–4 sentences. Plain prose — no headings, no bullet points. Plain text only, no HTML tags. Use \\n for line breaks.${profileBlock(profile)}${langText(locale)}`;
  } else {
    prompt = `Teaching knobit "${knobitTitle}" within topic "${nodeLabel}".\n\nPrevious explanation the learner understood:\n"""\n${previousContent}\n"""\n\nWrite the NEXT step (byte ${byteIndex + 1}). Cover a new aspect or go one level deeper. Do NOT repeat or paraphrase what was already explained.\n2–4 sentences. Plain prose — no headings, no bullet points. Plain text only, no HTML tags. Use \\n for line breaks.${profileBlock(profile)}${langText(locale)}`;
  }
  return _streamText({ model: SONNET, max_tokens: 300, system: TUTOR_SYSTEM, messages: [{ role: 'user', content: prompt }] }, userId, 'explain_text', onChunk);
}

function streamRephrase(nodeLabel, knobitTitle, originalByte, mode, locale, profile, userId, onChunk) {
  const instructions = {
    rephrase: `The learner did not understand this explanation. Step back further.\nExplain the same concept from first principles — start from something even more basic,\nuse a concrete real-world analogy, and build up slowly.\nDo NOT reuse the same wording. A different angle entirely.`,
    simpler:  `The learner found this too simplistic.\nRewrite it with professional, expert-level language. Use precise terminology,\na more formal framing, and the kind of depth an expert or researcher would appreciate.\nSame core concept — elevated register.`,
    complex:  `The learner found this too complex.\nRewrite using the simplest possible words. STRICT rules: every sentence must be at most 10 words long.\nMaximum 3 sentences per paragraph. No jargon — replace every technical term with a plain everyday word.\nUse one concrete real-life example (something a child could picture).\nSame core concept — maximally accessible.`,
  }[mode] || 'Rewrite this explanation from a different angle.';
  const prompt = `Topic: "${nodeLabel}" — Knobit: "${knobitTitle}"\n\nCurrent explanation:\n"""\n${originalByte}\n"""\n\n${instructions}\n\nWrite the replacement paragraph only — 2–4 sentences, no headings.${profileBlock(profile)}${langText(locale)}`;
  return _streamText({ model: SONNET, max_tokens: 200, system: TUTOR_SYSTEM, messages: [{ role: 'user', content: prompt }] }, userId, 'rephrase', onChunk);
}

function streamMeaning(nodeLabel, knobitTitle, locale, userId, onChunk) {
  const prompt = `Topic: "${nodeLabel}" — Knobit: "${knobitTitle}"\n\nWrite 2–3 sentences on why this matters in the real world.\nBe concrete: name a profession, product, decision, or daily situation where it directly applies.\nNo "In conclusion" — just the insight.${langText(locale)}`;
  return _streamText({ model: SONNET, max_tokens: 180, system: TUTOR_SYSTEM, messages: [{ role: 'user', content: prompt }] }, userId, 'meaning', onChunk);
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
      text: `You are a focused learning assistant inside the KnoBitz platform.\nYou help the learner with exactly one concept:\n  Knobit: "${knobitTitle}"\n  Topic: "${nodeLabel}"\n\nRules:\n1. Only answer questions relevant to this knobit or topic. If the question is clearly off-topic, reply warmly: "This chat is here to help you with '${knobitTitle}'. Happy to answer any questions about that!"\n2. Be concise: 2–4 sentences. Never repeat what is already in the context.\n3. No preamble — go straight to the helpful content.${practiceRule}`,
      cache_control: { type: 'ephemeral' },
    }],
    messages: [{ role: 'user', content: `Phase: ${phase}\nRecent content: "${context}"\nQuestion: "${question}"${profileBlock(profile)}${langText(locale)}` }],
  }, userId, 'ask', onChunk);
}

function streamTestQuestion(nodeLabel, breadcrumb, questionNum, history, locale, userId, onChunk) {
  testlog('llm_question_stream_start', { userId, nodeLabel, questionNum, historyLen: history.length }); // TESTLOG
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
    max_tokens: 400,
    system: [{
      type: 'text',
      text: `You are a knowledge diagnostic examiner. You generate exactly one question per tier of a 4-tier framework.\nReturn ONLY valid JSON with these fields:\n- "question": the question text (string)\n- "type": "open" or "mcq"\n- "options": array of 4 strings if type is "mcq", omit if "open"\n- "correctIndex": integer 0–3 indicating which option is correct, if type is "mcq"; omit if "open"\nFor MCQ: all four options must be similar in length and specificity. Distractors must be precise and plausible — not vague, not obviously wrong. A test-taker who doesn't know the topic must not be able to identify the correct answer by its style, length, or level of detail.\nDo not add any explanation outside the JSON.`,
      cache_control: { type: 'ephemeral' },
    }],
    messages: [{
      role: 'user',
      content: `Topic: "${nodeLabel}" (${breadcrumb})\nTier ${questionNum}: ${tiers[questionNum - 1]}\n${adaptNote}\n${historyText ? `\nPrevious Q&A:\n${historyText}` : ''}\n\nGenerate question ${questionNum}. Choose open or MCQ based on what best tests this tier.\nFor MCQ: provide exactly 4 options, include correctIndex (0–3). Return JSON only.${langJson(locale)}`,
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
  const _stePrompt = isLast // TESTLOG
    ? `Topic: "${nodeLabel}" (${breadcrumb})\n\nFull Q&A:\n${historyText}\n\n[Q4 evaluation prompt — see correctIndex in route log]` // TESTLOG
    : `Topic: "${nodeLabel}"\nQuestion: "${question}"\nOptions: ${options ? options.map(function(o,i){return (i+1)+'. '+o;}).join(' | ') : 'none'}\nCorrectIndex: ${correctIndex}\nAnswer: "${userAnswer}"`; // TESTLOG
  testlog('llm_evaluate_stream_prompt', { userId, questionNum, isLast, prompt: _stePrompt }); // TESTLOG
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
        : (function() {
            var mcq = _mcqEvalBlock(userAnswer, options, correctIndex);
            return mcq
              ? `Topic: "${nodeLabel}"\nQuestion: "${question}"\n\n${mcq}\n\nReturn JSON with:\n- "correct": boolean (use the Verdict above — do not re-evaluate)\n- "partial": false (MCQ is always fully correct or incorrect)\n- "feedback": 1-2 sentences — if correct, confirm and briefly explain why; if incorrect, explain what the right answer means${langJson(locale)}`
              : `Topic: "${nodeLabel}"\nQuestion: "${question}"\nAnswer: "${userAnswer}"\n\nReturn JSON with:\n- "correct": boolean — true if the answer reflects a good grasp and understanding of the issue\n- "partial": boolean — true if partially correct or noticeably incomplete\n- "score": integer 0–25 (25 = full understanding; 15–24 = good grasp with minor gaps; 8–14 = partial; 1–7 = surface only; 0 = incorrect)\n- "feedback": 1-2 sentences — confirm if correct, note what's missing if partial, or explain the right answer if wrong${langJson(locale)}`;
          }()),
    }],
  }, userId, 'test_evaluate', onChunk);
}

module.exports = {
  generateOverview,
  generateKnobits,
  translateKnobitTitles,
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
};
