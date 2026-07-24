// ── Helper temps Brazzaville (UTC+1) ──
const OFFSET_BRAZZA_MS = 1 * 60 * 60 * 1000;

function todayBrazza() {
  return new Date(Date.now() + OFFSET_BRAZZA_MS).toISOString().split('T')[0];
}

module.exports = { OFFSET_BRAZZA_MS, todayBrazza };