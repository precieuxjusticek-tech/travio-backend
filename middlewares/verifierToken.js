const { auth, firestore } = require('../firebase');

async function verifierToken(req, res, next) {

  // ← ajouté : laisse passer le cron interne (badge spécial)
  if (req.headers['x-internal-key'] === process.env.INTERNAL_CRON_KEY) {
    return next();
  }

  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Authentification requise.' });
  }

  const idToken = authHeader.split('Bearer ')[1];

  try {
    const decoded = await auth.verifyIdToken(idToken);

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