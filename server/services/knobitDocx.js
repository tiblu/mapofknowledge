const { Document, Packer, Paragraph, TextRun, HeadingLevel, ExternalHyperlink } = require('docx');

// Mirrors the client's phase.step_N + phase.* i18n pairs (app/js/learning.js /
// i18n_seed.sql) so the downloaded document uses the same wording the learner saw.
const PHASE_HEADINGS = {
  explain:     { en: 'Step 1 — Explain',      et: '1. samm — Selgitus' },
  demonstrate: { en: 'Step 2 — Demonstrate',  et: '2. samm — Näide' },
  practice:    { en: 'Step 3 — Practice',     et: '3. samm — Ülesanne' },
  meaning:     { en: 'Step 4 — Meaning',      et: '4. samm — Tähendus' },
};

const LABELS = {
  example:     { en: 'Example',      et: 'Näide' },
  what_i_did:  { en: 'What I did:',  et: 'Mida ma tegin:' },
  problem:     { en: 'Problem',      et: 'Ülesanne' },
  your_answer: { en: 'Your answer:', et: 'Sinu vastus:' },
  watch_video: { en: 'Watch video',  et: 'Vaata videot' },
  you_asked:   { en: 'You asked:',   et: 'Sa küsisid:' },
};

function _tr(map, locale) {
  return (map[locale] || map.en);
}

function _safeParse(json) {
  try { return JSON.parse(json || '{}'); } catch { return {}; }
}

// Same normalization as the client: LLM output occasionally leaks a literal
// "\n" (two chars) instead of a real newline character.
function _normalize(text) {
  return String(text || '').replace(/\\n/g, '\n');
}

// Splits a line on "**bold**" markers into TextRuns — mirrors the client's
// defensive **bold** handling (_mdBold) in case the model slips markdown in
// despite being told not to.
function _lineToRuns(line) {
  var parts = String(line).split(/(\*\*.+?\*\*)/g).filter(function (p) { return p !== ''; });
  return parts.map(function (part) {
    var m = part.match(/^\*\*(.+)\*\*$/);
    return m ? new TextRun({ text: m[1], bold: true }) : new TextRun(part);
  });
}

// Turns a block of text into Paragraphs, promoting "- item" / "1. item" lines
// into real bullet/numbered paragraphs — mirrors the client's _renderTextWithLists.
function _textToParagraphs(text) {
  var lines = _normalize(text).split('\n');
  var paras = [];
  lines.forEach(function (line) {
    var bulletMatch = line.match(/^-\s+(.*)/);
    var numberMatch = line.match(/^\d+\.\s+(.*)/);
    if (bulletMatch) {
      paras.push(new Paragraph({ children: _lineToRuns(bulletMatch[1]), bullet: { level: 0 } }));
    } else if (numberMatch) {
      paras.push(new Paragraph({ children: _lineToRuns(numberMatch[1]), bullet: { level: 0 } }));
    } else if (line.trim()) {
      paras.push(new Paragraph({ children: _lineToRuns(line.trim()) }));
    }
  });
  return paras;
}

// rows: knobit_interactions rows for one (passport_id, knobit_id), ordered by id.
// Returns a Buffer (the .docx file contents).
async function buildKnobitDocx(rows, nodeLabel, knobitTitle, locale) {
  var children = [
    new Paragraph({ text: nodeLabel || '', heading: HeadingLevel.TITLE }),
    new Paragraph({ text: knobitTitle || '', heading: HeadingLevel.HEADING_1 }),
  ];

  var lastPhase = null;

  rows.forEach(function (row) {
    if (row.phase !== lastPhase) {
      var heading = PHASE_HEADINGS[row.phase] ? _tr(PHASE_HEADINGS[row.phase], locale) : row.phase;
      children.push(new Paragraph({ text: heading, heading: HeadingLevel.HEADING_2 }));
      lastPhase = row.phase;
    }

    if (row.block_type === 'byte' || row.block_type === 'meaning') {
      children = children.concat(_textToParagraphs(row.content));
    } else if (row.block_type === 'visual') {
      var v = _safeParse(row.content);
      if (v.url) {
        var linkText = v.caption || (v.type === 'video' ? _tr(LABELS.watch_video, locale) : v.url);
        var prefix = v.type === 'video' ? '🎬 ' : '🖼 ';
        children.push(new Paragraph({
          children: [
            new TextRun(prefix),
            new ExternalHyperlink({ children: [new TextRun({ text: linkText, style: 'Hyperlink' })], link: v.url }),
          ],
        }));
      }
    } else if (row.block_type === 'example') {
      var ex = _safeParse(row.content);
      children.push(new Paragraph({
        children: [new TextRun({ text: _tr(LABELS.example, locale) + ' ' + (row.block_index + 1), bold: true })],
      }));
      children = children.concat(_textToParagraphs(ex.body));
      if (ex.whatIDid) {
        children.push(new Paragraph({
          children: [new TextRun({ text: _tr(LABELS.what_i_did, locale) + ' ', italics: true }), new TextRun({ text: ex.whatIDid, italics: true })],
        }));
      }
    } else if (row.block_type === 'practice') {
      var prob = _safeParse(row.content);
      children.push(new Paragraph({
        children: [
          new TextRun({ text: _tr(LABELS.problem, locale) + ' ' + (row.block_index + 1) + ': ', bold: true }),
          new TextRun(prob.question || ''),
        ],
      }));
    } else if (row.block_type === 'feedback') {
      var grade = _safeParse(row.content);
      if (row.answer_text) {
        children.push(new Paragraph({
          children: [new TextRun({ text: _tr(LABELS.your_answer, locale) + ' ', bold: true }), new TextRun(row.answer_text)],
        }));
      }
      children.push(new Paragraph({ text: (grade.correct ? '✓ ' : '✗ ') + (grade.feedback || '') }));
    } else if (row.block_type === 'user') {
      children.push(new Paragraph({
        children: [
          new TextRun({ text: _tr(LABELS.you_asked, locale) + ' ', bold: true, italics: true }),
          new TextRun({ text: row.content || '', italics: true }),
        ],
      }));
    } else if (row.block_type === 'note') {
      children = children.concat(_textToParagraphs(row.content));
    }
  });

  var doc = new Document({ sections: [{ children: children }] });
  return Packer.toBuffer(doc);
}

module.exports = { buildKnobitDocx };
