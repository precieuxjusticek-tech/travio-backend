// ─── TRAVIO — Protection XSS côté backend ───

const CHAMPS_EXCLUS = new Set(['password', 'newPassword', 'confirmPassword']);
const sanitizeHtml = require('sanitize-html');

// APRÈS
function stripHtml(str) {
  if (typeof str !== 'string') return str;
  return sanitizeHtml(str, {
    allowedTags: [],        // aucun tag HTML autorisé (comportement identique à avant : tout texte brut)
    allowedAttributes: {},  // aucun attribut autorisé
    disallowedTagsMode: 'discard', // supprime le tag ET son contenu pour <script>, <style>
  }).trim();
}

function sanitizeValue(value, key = null) {
  if (key && CHAMPS_EXCLUS.has(key)) return value;
  if (typeof value === 'string') return stripHtml(value);
  if (Array.isArray(value)) return value.map(v => sanitizeValue(v));
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) {
      out[k] = sanitizeValue(value[k], k);
    }
    return out;
  }
  return value;
}

function sanitizeInput(req, res, next) {
  if (req.body && typeof req.body === 'object') {
    req.body = sanitizeValue(req.body);
  }
  if (req.query && typeof req.query === 'object') {
    req.query = sanitizeValue(req.query);
  }
  next();
}

module.exports = { sanitizeInput, sanitizeValue, stripHtml };