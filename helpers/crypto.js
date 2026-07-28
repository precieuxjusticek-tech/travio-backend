const crypto = require('crypto');

const ALGORITHM = 'aes-256-cbc';
const KEY = Buffer.from(process.env.ENCRYPTION_KEY, 'hex');

function encrypt(text) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, KEY, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

// Détecte si une chaîne a le format d'un mot de passe chiffré (iv:données, iv = 32 caractères hex)
function estChiffre(text) {
  if (typeof text !== 'string') return false;
  const parts = text.split(':');
  return parts.length === 2 && /^[0-9a-f]{32}$/i.test(parts[0]);
}

function decrypt(encryptedText) {
  // Rétrocompatibilité : si ce n'est pas un format chiffré reconnu, on suppose que c'est un ancien mot de passe en clair
  if (!estChiffre(encryptedText)) {
    return encryptedText;
  }

  try {
    const [ivHex, encrypted] = encryptedText.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, KEY, iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (err) {
    // Sécurité supplémentaire : si le déchiffrement échoue malgré tout, on ne plante pas
    console.error('Erreur déchiffrement mot de passe :', err.message);
    return encryptedText;
  }
}

module.exports = { encrypt, decrypt };