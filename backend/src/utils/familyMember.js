/**
 * familyMember.js – shared family-member name normalisation.
 * "  jane   DOE " → "Jane Doe"; blank, "self" or "you" → "Self".
 */
const DEFAULT_FAMILY_MEMBER = 'Self';

function normalizeFamilyMember(value) {
  if (typeof value !== 'string') return DEFAULT_FAMILY_MEMBER;
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (!normalized) return DEFAULT_FAMILY_MEMBER;
  const lower = normalized.toLowerCase();
  if (lower === 'self' || lower === 'you') return DEFAULT_FAMILY_MEMBER;
  return normalized
    .split(' ')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

module.exports = { DEFAULT_FAMILY_MEMBER, normalizeFamilyMember };
