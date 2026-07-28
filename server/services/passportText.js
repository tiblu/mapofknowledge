// Renders a full Learner Passport (as returned by GET /profile in
// server/routes/api.js) into plain prose for Anne's system prompt context.
// Distinct from llm.js's profileBlock() — that's a thin field nudge used to
// bias example selection in generation prompts; this covers the whole
// passport for a mentor who needs to actually discuss it with the learner.

const HATE = /\b(nazi|white.suprem|nigger|faggot|kike|slut|whore|chink|spic)\b/i;
function safe(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s || HATE.test(s)) return null;
  return s;
}

function renderPassportText(data) {
  const sections = [];

  // ── Identity / about ────────────────────────────────────────────────
  const p = data.passport;
  if (p) {
    const bits = [];
    if (p.display_name) bits.push(`Name: ${p.display_name}`);
    if (p.birth_year) {
      const age = new Date().getFullYear() - p.birth_year;
      if (age > 3 && age < 120) bits.push(`Age: ${age}`);
    }
    const loc = safe(p.location);
    if (loc) bits.push(`Location: ${loc}`);
    const cult = safe(p.cultural_background);
    if (cult) bits.push(`Cultural background: ${cult}`);
    const about = safe(p.about);
    if (about) bits.push(`About: ${about}`);
    if (bits.length) sections.push(`LEARNER\n${bits.join('. ')}.`);
  }

  // ── Learning style ───────────────────────────────────────────────────
  const ls = data.learningStyle;
  if (ls) {
    const bits = [];
    if (ls.modalities) bits.push(`Preferred modalities: ${ls.modalities}`);
    if (ls.peak_time) bits.push(`Peak learning time: ${ls.peak_time}`);
    if (ls.session_length) bits.push(`Preferred session length: ${ls.session_length}`);
    const works = safe(ls.works_best);
    if (works) bits.push(`What works best: ${works}`);
    const needs = safe(ls.needs);
    if (needs) bits.push(`Needs: ${needs}`);
    if (ls.accessibility) bits.push(`Accessibility: ${ls.accessibility}`);
    if (bits.length) sections.push(`LEARNING STYLE\n${bits.join('. ')}.`);
  }

  // ── Interests / values ───────────────────────────────────────────────
  const tags = (data.tags || []).slice(0, 30);
  const interests = tags.filter(t => t.type === 'interest').map(t => safe(t.text)).filter(Boolean);
  const values = tags.filter(t => t.type === 'value').map(t => safe(t.text)).filter(Boolean);
  if (interests.length) sections.push(`INTERESTS\n${interests.join(', ')}.`);
  if (values.length) sections.push(`VALUES\n${values.join(', ')}.`);

  // ── Goals ────────────────────────────────────────────────────────────
  // MoK's goals are simple free-text notes with just a status (in_progress/
  // completed) — no progress percentage or target date, unlike KnobitMap's
  // richer goal model.
  const goals = (data.goals || []).slice(0, 15);
  if (goals.length) {
    const lines = goals.map(g => {
      const text = safe(g.text) || '(untitled goal)';
      const status = g.status === 'completed' ? 'completed' : 'in progress';
      return `- ${text} (${status})`;
    });
    sections.push(`GOALS\n${lines.join('\n')}`);
  }

  // ── Aspirations / objectives / plans ─────────────────────────────────
  const aspirations = (data.aspirations || []).slice(0, 15).map(a => safe(a.text)).filter(Boolean);
  if (aspirations.length) sections.push(`ASPIRATIONS\n${aspirations.map(a => `- ${a}`).join('\n')}`);

  const objectives = (data.objectives || []).slice(0, 15);
  if (objectives.length) {
    const lines = objectives.map(o => {
      const title = safe(o.title) || '(untitled objective)';
      const status = o.status === 'completed' ? 'completed' : 'active';
      const target = safe(o.target_description);
      return `- ${title} (${status})${target ? `: ${target}` : ''}`;
    });
    sections.push(`OBJECTIVES\n${lines.join('\n')}`);
  }

  const plans = (data.plans || []).slice(0, 15);
  if (plans.length) {
    const lines = plans.map(pl => {
      const title = safe(pl.title) || '(untitled plan)';
      const desc = safe(pl.description);
      return `- [${pl.frequency}] ${title}${desc ? `: ${desc}` : ''}`;
    });
    sections.push(`PLANS\n${lines.join('\n')}`);
  }

  // ── Competence ───────────────────────────────────────────────────────
  const competence = (data.competence || []).slice(0, 25);
  if (competence.length) {
    const lines = competence.map(c => {
      const desc = safe(c.description);
      return `- ${c.name} (${c.type}, level ${c.level}${c.proficiency_label ? ` — ${c.proficiency_label}` : ''})${desc ? `: ${desc}` : ''}`;
    });
    sections.push(`COMPETENCE\n${lines.join('\n')}`);
  }

  // ── Map knowledge — aggregate by domain, plus top examples ───────────
  const mapKnowledge = data.mapKnowledge || [];
  if (mapKnowledge.length) {
    const byDomain = {};
    for (const row of mapKnowledge) {
      const domain = (row.breadcrumb && row.breadcrumb.split(' › ')[0]) || row.label;
      if (!byDomain[domain]) byDomain[domain] = { count: 0, sum: 0 };
      byDomain[domain].count++;
      byDomain[domain].sum += Number(row.percentage) || 0;
    }
    const domainLines = Object.entries(byDomain)
      .sort((a, b) => b[1].count - a[1].count)
      .map(([domain, d]) => `- ${domain}: ${d.count} node${d.count === 1 ? '' : 's'} touched, avg ${Math.round(d.sum / d.count)}%`);

    const topNodes = [...mapKnowledge]
      .sort((a, b) => (b.percentage || 0) - (a.percentage || 0))
      .slice(0, 15)
      .map(row => `- ${row.label}${row.breadcrumb ? ` (${row.breadcrumb})` : ''}: ${row.percentage}%`);

    sections.push(`MAP KNOWLEDGE — by domain\n${domainLines.join('\n')}`);
    sections.push(`MAP KNOWLEDGE — strongest topics\n${topNodes.join('\n')}`);
  }

  // ── Recent events ────────────────────────────────────────────────────
  const events = (data.events || []).slice(0, 15);
  if (events.length) {
    const lines = events.map(e => {
      const title = safe(e.title) || '(untitled event)';
      const inst = safe(e.institution);
      const result = safe(e.result);
      const date = e.event_date ? new Date(e.event_date).toISOString().slice(0, 10) : '';
      return `- [${date}] ${title}${inst ? ` (${inst})` : ''}${result ? ` — ${result}` : ''}`;
    });
    sections.push(`RECENT EVENTS\n${lines.join('\n')}`);
  }

  // ── Recent reflections ───────────────────────────────────────────────
  const reflections = (data.reflections || []).slice(0, 10);
  if (reflections.length) {
    const lines = reflections.map(r => {
      const text = safe(r.text);
      if (!text) return null;
      const context = safe(r.event_title) ? ` (on: ${safe(r.event_title)})` : '';
      return `- ${text}${context}`;
    }).filter(Boolean);
    if (lines.length) sections.push(`RECENT REFLECTIONS\n${lines.join('\n')}`);
  }

  // ── Relationships ────────────────────────────────────────────────────
  const relationships = (data.relationships || []).slice(0, 15);
  if (relationships.length) {
    const lines = relationships.map(r => {
      const name = safe(r.name) || '(unnamed)';
      const role = safe(r.role_description);
      return `- ${name} (${r.type}${r.status ? `, ${r.status}` : ''})${role ? `: ${role}` : ''}`;
    });
    sections.push(`RELATIONSHIPS\n${lines.join('\n')}`);
  }

  // ── Credentials ──────────────────────────────────────────────────────
  const credentials = (data.credentials || []).slice(0, 20);
  if (credentials.length) {
    const lines = credentials.map(c => {
      const title = safe(c.title) || '(untitled)';
      const issuer = safe(c.issuer);
      const date = c.awarded_date ? new Date(c.awarded_date).toISOString().slice(0, 10) : '';
      return `- ${title}${issuer ? ` (${issuer})` : ''}${date ? `, ${date}` : ''}`;
    });
    sections.push(`CREDENTIALS\n${lines.join('\n')}`);
  }

  return sections.join('\n\n');
}

module.exports = { renderPassportText };
