/** Shared buying-signal rules. Offer codes are stable; explanations are display text. */
const SIGNALS = [
  // Sales-pipeline grunt work: sourcing, enriching, list-building.
  [/lead gen(eration)?\b|list build|prospect(ing| research)|sales research|data enrich|contact discovery|lead qualif/i, 10, 'Offer B — lead pipeline'],
  // Back-office data handling: the canonical automatable job.
  [/data entry|data processing|data annotation|data clean|data migration|order (entry|processing)|back.?office|document processing|records management|transcription/i, 10, 'back-office data work'],
  // Finance/admin processing that is really data movement.
  [/invoice processing|accounts payable clerk|billing (specialist|clerk)|claims processing|payroll (clerk|administrator)|reconciliation (clerk|specialist)/i, 9, 'processing busywork'],
  // Manual outbound.
  [/\bsdr\b|\bbdr\b|sales development rep|appointment setter|cold call/i, 8, 'manual prospecting'],
  // Internal knowledge work our doc assistant covers.
  [/knowledge (base|management)|documentation (specialist|coordinator)|content operations/i, 8, 'Offer A — doc assistant'],
];

// Anything in here is not our buyer, whatever else the title says.
const NEGATIVE = new RegExp([
  'engineer','developer','scientist','architect','designer','programmer','devops','\\bqa\\b',
  'nurse','clinical','medical','phlebotom','patient','physician','therapist','pharmac','liaison','caregiver','dental',
  'babysit','nanny','childcare','teacher','tutor','instructor','professor',
  'driver','warehouse','technician','mechanic','electric','plumb','construction','janitor','custodian','security guard',
  'attorney','counsel','paralegal','accountant','auditor','controller',
  'chef','cook','barista','server','retail associate','cashier',
  'intern\\b','internship','volunteer',
  'director','\\bvp\\b','vice president','head of','chief ',
].join('|'), 'i');

// Seniority is the real tell: a Manager/Director of Demand Gen sets strategy,
// an Associate/Coordinator/Agent does the repetitive work we replace.
const DOER = /associate|assistant|coordinator|representative|\bagent\b|junior|\bjr\b|specialist|clerk|administrator|analyst|executive\b/i;
const LEADER = /manager|director|\bhead\b|principal|senior|\bsr\.?\b|\blead\b|chief|vp\b|strategist/i;

export function classify(title) {
  if (NEGATIVE.test(title)) return null;
  for (const [re, score, why] of SIGNALS) {
    if (!re.test(title)) continue;
    let sc = score;
    if (DOER.test(title)) sc += 3;        // the person doing the work
    if (LEADER.test(title.replace(/lead gen(?:eration)?/ig, 'prospecting'))) sc -= 5;      // sets strategy, is not the manual labour
    const offer = why.startsWith('Offer A') ? 'A' : why.startsWith('Offer B') || why === 'manual prospecting' ? 'B' : 'ops';
    return sc >= 8 ? { score: sc, why, offer } : null;
  }
  return null;
}

/*
 * Description-based qualification (deterministic; no model calls).
 *
 * Titles only nominate a job. The description decides whether the actual duties
 * are repeated digital research/data work we could plausibly automate. The
 * result is a hypothesis about workflow fit: a job opening does not establish
 * buying intent, budget or a wish to replace staff.
 *
 * Statuses: qualified | review | rejected | insufficient (description too short).
 * Fetch failures are mapped by the collector before these rules run.
 */
const DUTIES = {
  B: [
    [/\bcrm\b|salesforce|hubspot|pipedrive|zoho crm/i, 'CRM work'],
    [/sales navigator|linkedin|apollo\.io|\bapollo\b|zoominfo|lusha/i, 'prospecting data tools'],
    [/(target|prospect|key)[- ]accounts?|account research|(research|identify|source)\w* (target |potential |new )?(compan|prospect|lead|account|decision.?maker|contact)/i, 'prospect/account research'],
    [/(build|maintain|create|update|clean|grow)\w* (and \w+ )?(\w+ )?(prospect|lead|contact|target|outreach|account)s? (lists?|databases?)|list[- ]building/i, 'list building'],
    [/dedup|duplicate (records|entries|contacts)|data (hygiene|quality|accuracy|integrity|validation|enrichment)|enrich\w*|verify contact|contact (data|details|information) (accuracy|validation)/i, 'data hygiene/enrichment'],
  ],
  ops: [
    [/data entry|enter(ing)? data|input(ting)? data|key(ing)? in data/i, 'data entry'],
    [/spreadsheet|excel\b|google sheets/i, 'spreadsheet work'],
    [/\berp\b|\bsap\b|netsuite|quickbooks|xero|internal systems?|back.?office systems?/i, 'business systems'],
    [/reconcil|payment confirmations?|invoices?\b|billing (accuracy|records|data)|purchase orders?|process(ing)? orders|order processing/i, 'transaction processing'],
    [/(update|maintain|manage)\w* (\w+ )?(records|database|price lists?|pricing)|configur\w* (client |customer )?accounts|routing/i, 'records/configuration upkeep'],
    [/(process|review|scan|index|classify|extract)\w* (\w+ )?(documents?|forms|applications|files)|document (processing|management)/i, 'document processing'],
    [/(validat|check|verif)\w* (\w+ )?(data|accuracy|records|entries|information)/i, 'data validation'],
  ],
  A: [
    [/knowledge base|internal documentation|(write|maintain|update)\w* (\w+ )?(documentation|sops?|procedures|manuals)/i, 'documentation upkeep'],
  ],
};
const IN_PERSON = /\bkiosks?\b|in[- ]store|retail (stores?|locations?|floor|events?)|\bmalls?\b|trade shows?|home shows?|\bbooths?\b|door[- ]to[- ]door|face[- ]to[- ]face|walk[- ]?ins?\b|in[- ]person|on your feet|canvass|street (team|marketing)|in[- ]home (appointments?|consultations?)|(local|community|retail|live) events?/i;
const SUPPORT = /customer (support|service|care)|inbound calls|answer(ing)? (phone )?calls|support tickets|help ?desk|live chat|(respond|reply)\w* to (customer|client) (inquiries|queries|emails|requests)|call cent(er|re)|complaints/i;
const STRATEGIC = /(develop|define|own|drive|lead)\w* (and execute )?(the |our )?(\w+ )?strateg|own (the |our )?(pipeline|revenue|quota|p&l)|\bquotas?\b|clos(e|ing) deals|manag\w* (a |the )?team|team lead|negotiat|account executive|full sales cycle|budget responsibility/i;
const OUTSOURCED = /\bbpo\b|outsourc|on behalf of (our )?clients|for our clients|client projects?|\brpa\b|business process (outsourcing|services)/i;
const REGULATED = /\bkyc\b|\baml\b|anti[- ]money laundering|customs (declarations?|clearance|documentation|entries)|hipaa|debt (collection|recovery|cases?)|insurance claims|medical records|legal (documents|cases)|licensed (broker|agent)/i;
const ENGLISH = new Set('the and to of a in for with you our is will on are be as your we this that or an have by from at who'.split(' '));
export const MIN_DESCRIPTION_CHARS = 300;

const withGlobal = re => new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
function snippets(text, re, limit = 2) {
  const out = [];
  for (const m of text.matchAll(withGlobal(re))) {
    const start = Math.max(0, m.index - 50), end = Math.min(text.length, m.index + m[0].length + 50);
    out.push(text.slice(start, end).replace(/\s+/g, ' ').trim());
    if (out.length >= limit) break;
  }
  return out;
}
const countMatches = (text, re) => [...text.matchAll(withGlobal(re))].length;

/**
 * Judge a job description. `titleSignal` is the classify() result for the title.
 * Returns { status, offer, offerSource, reasons[], evidence } where evidence holds
 * short quoted snippets for every duty, blocker and review flag that fired.
 */
export function qualifyDescription(text, titleSignal = {}) {
  const body = String(text ?? '');
  const evidence = { duties: [], inPerson: [], support: [], strategic: [], outsourced: [], regulated: [] };
  if (body.trim().length < MIN_DESCRIPTION_CHARS) {
    return { status: 'insufficient', offer: titleSignal.offer ?? null, offerSource: 'title', reasons: [`description shorter than ${MIN_DESCRIPTION_CHARS} characters; duties cannot be judged`], evidence };
  }
  const perOffer = {};
  for (const [offer, rules] of Object.entries(DUTIES)) {
    for (const [re, label] of rules) {
      const hits = snippets(body, re, 1);
      if (!hits.length) continue;
      perOffer[offer] = (perOffer[offer] ?? 0) + 1;
      evidence.duties.push({ offer, duty: label, quote: hits[0] });
    }
  }
  const dutyCount = evidence.duties.length;
  const inPerson = countMatches(body, IN_PERSON), support = countMatches(body, SUPPORT), strategic = countMatches(body, STRATEGIC);
  evidence.inPerson = snippets(body, IN_PERSON); evidence.support = snippets(body, SUPPORT); evidence.strategic = snippets(body, STRATEGIC);
  evidence.outsourced = snippets(body, OUTSOURCED); evidence.regulated = snippets(body, REGULATED);

  // Offer: the duty family with the most distinct matches; the title's offer breaks ties.
  const ranked = Object.entries(perOffer).sort((a, b) => b[1] - a[1] || (a[0] === titleSignal.offer ? -1 : b[0] === titleSignal.offer ? 1 : 0));
  const offer = ranked[0]?.[0] ?? titleSignal.offer ?? null;
  const offerSource = ranked.length ? 'description' : 'title';

  // Hard rejections: the actual job is not digital research/data work.
  if (inPerson >= 2 && dutyCount < 2) {
    return { status: 'rejected', offer, offerSource, reasons: ['duties are in-person retail/event work, not digital research or data handling'], evidence };
  }
  if (support >= 2 && support > dutyCount) {
    return { status: 'rejected', offer, offerSource, reasons: ['duties are primarily customer support'], evidence };
  }

  // Context a person must judge rather than an automatic verdict.
  const review = [];
  if (inPerson >= 1) review.push('mentions in-person/field work alongside desk duties');
  if (support >= 2) review.push('mixes customer-support duties with data work');
  if (strategic >= 2) review.push('broader strategic or quota-carrying sales role');
  if (evidence.outsourced.length) review.push('outsourced/BPO delivery context; the client may own the workflow');
  if (evidence.regulated.length) review.push('regulated or specialist domain; needs domain-specific discovery');
  const words = body.toLowerCase().match(/\p{L}+/gu) ?? [];
  const english = words.filter(w => ENGLISH.has(w)).length / Math.max(1, words.length);
  if (words.length >= 40 && english < 0.06) review.push('non-English or mixed-language description');
  if (dutyCount === 0) review.push('no concrete repeated research/data duties found in the description');
  else if (dutyCount === 1) review.push('only one concrete research/data duty found');
  if (review.length) return { status: 'review', offer, offerSource, reasons: review, evidence };

  const duties = [...new Set(evidence.duties.map(d => d.duty))].join(', ');
  return { status: 'qualified', offer, offerSource, reasons: [`description lists ${dutyCount} repeated research/data duties: ${duties}`], evidence };
}
