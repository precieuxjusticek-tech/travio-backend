const { auth, firestore } = require('../firebase');
const crypto = require('crypto');

function comparaisonSecurisee(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

async function verifierToken(req, res, next) {

  // Laisse passer le cron interne (clé partagée, jamais un vrai utilisateur)
  if (process.env.INTERNAL_CRON_KEY && comparaisonSecurisee(req.headers['x-internal-key'], process.env.INTERNAL_CRON_KEY)) {
    req.user = { internal: true, role: 'system' };
    return next();
  }

  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Authentification requise.' });
  }

  const idToken = authHeader.split('Bearer ')[1];

  try {
    const decoded = await auth.verifyIdToken(idToken, true);

    const userDoc = await firestore.collection('users').doc(decoded.uid).get();
    if (!userDoc.exists) {
      return res.status(404).json({ message: 'Profil utilisateur introuvable.' });
    }
    const userData = userDoc.data();

    req.user = {
      uid:      decoded.uid,
      email:    decoded.email,
      role:     userData.role,
      agenceId: userData.agenceId,
      pdvId:    userData.pdvId || null,
    };
    next();
  } catch (err) {
    console.error('Token invalide :', err.message);
    return res.status(401).json({ message: 'Session invalide, reconnectez-vous.' });
  }
}

module.exports = { verifierToken };