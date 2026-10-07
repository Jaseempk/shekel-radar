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
