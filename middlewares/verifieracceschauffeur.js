const { firestore } = require('../firebase');

// ════════════════════════════════
//  MIDDLEWARE — Accès chauffeur (lien partagé, sans compte)
//  Attend agenceId + token en query string (ou body pour les PATCH)
// ════════════════════════════════
async function verifierAccesChauffeur(req, res, next) {
  const agenceId = req.query.agenceId || req.body.agenceId;
  const token    = req.query.token    || req.body.token;

  if (!agenceId || !token) {
    return res.status(401).json({ message: 'Accès refusé — lien invalide.' });
  }

  try {
    const agenceDoc = await firestore.collection('agences').doc(agenceId).get();
    if (!agenceDoc.exists) {
      return res.status(401).json({ message: 'Accès refusé — lien invalide.' });
    }

    const agence = agenceDoc.data();

    if (!agence.chauffeurAccessToken || agence.chauffeurAccessToken !== token) {
      return res.status(401).json({ message: 'Accès refusé — lien invalide ou révoqué.' });
    }

    // On attache l'agenceId vérifié à la requête, pour que les routes ne fassent
    // jamais confiance à un agenceId brut envoyé par le client sans validation.
    req.agenceId = agenceId;
    next();

  } catch (err) {
    console.error('Erreur verifierAccesChauffeur :', err);
    return res.status(500).json({ message: 'Erreur serveur.' });
  }
}

module.exports = { verifierAccesChauffeur };