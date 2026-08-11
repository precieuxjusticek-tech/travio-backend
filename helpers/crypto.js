const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const KEY = Buffer.from(process.env.ENCRYPTION_KEY, 'hex');

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, KEY, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  return iv.toString('hex') + ':' + encrypted + ':' + authTag;
}

// Détecte si une chaîne a le format d'un mot de passe chiffré
// Nouveau format GCM : iv(24 hex):données:authTag(32 hex)  → 3 segments
// Ancien format CBC  : iv(32 hex):données                  → 2 segments
function estChiffre(text) {
  if (typeof text !== 'string') return false;
  const parts = text.split(':');
  if (parts.length === 3) return /^[0-9a-f]{24}$/i.test(parts[0]);
  if (parts.length === 2) return /^[0-9a-f]{32}$/i.test(parts[0]);
  return false;
}

function decrypt(encryptedText) {
  if (!estChiffre(encryptedText)) {
    return encryptedText;
  }

  const parts = encryptedText.split(':');

  try {
    if (parts.length === 3) {
      // Nouveau format GCM
      const [ivHex, encrypted, authTagHex] = parts;
      const iv = Buffer.from(ivHex, 'hex');
      const decipher = crypto.createDecipheriv(ALGORITHM, KEY, iv);
      decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
      let decrypted = decipher.update(encrypted, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      return decrypted;
    } else {
      // Ancien format CBC — rétrocompatibilité pour les mots de passe déjà stockés
      const [ivHex, encrypted] = parts;
      const iv = Buffer.from(ivHex, 'hex');
      const decipher = crypto.createDecipheriv('aes-256-cbc', KEY, iv);
      let decrypted = decipher.update(encrypted, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      return decrypted;
    }
  } catch (err) {
    console.error('Erreur déchiffrement mot de passe :', err.message);
    throw new Error('Déchiffrement impossible');
    return encryptedText;
  }
}

module.exports = { encrypt, decrypt };