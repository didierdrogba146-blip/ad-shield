// Shared by background.js and cosmetic.js so both sides agree on what "the
// same site" means. A small list of two-level public suffixes is enough here;
// it covers the common country-code layouts such as .com.tr and .co.uk.
const TWO_LEVEL_SUFFIX = /^(com|net|org|gov|edu|co|gen|web|bel|k12|av|dr|biz|info|tv|tsk|pol|ac|ltd|plc|me|ne|or|go)$/;

function baseDomain(h) {
  const p = (h || '').toLowerCase().split('.');
  if (p.length <= 2) return p.join('.');
  const twoLevel = TWO_LEVEL_SUFFIX.test(p[p.length - 2]) && p[p.length - 1].length === 2;
  return p.slice(twoLevel ? -3 : -2).join('.');
}

function sameSite(a, b) {
  return !!a && !!b && baseDomain(a) === baseDomain(b);
}
