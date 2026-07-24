const express = require('express');
const router  = express.Router();

const { firestore } = require('../firebase');

// ════════════════════════════════
//  LISTE DES AGENCES
//  GET /admin/agences?adminKey=xxx
// ════════════════════════════════
router.get('/agences', async (req, res) => {
  const { adminKey } = req.query;
  if (adminKey !== process.env.ADMIN_SECRET_KEY) {
    return res.status(403).json({ message: 'Non autorisé.' });
  }
  try {
    const snapshot = await firestore.collection('agences').orderBy('createdAt', 'desc').get();
    const agences = [];

    for (const doc of snapshot.docs) {
      const a = doc.data();

      const pdvSnap = await firestore.collection('pointsDeVente')
        .where('agenceId', '==', a.id).where('actif', '==', true).get();

      let pdg = null;
      if (a.adminUid) {
        const userDoc = await firestore.collection('users').doc(a.adminUid).get();
        if (userDoc.exists) {
          const u = userDoc.data();
          pdg = `${u.prenom || ''} ${u.nom || ''}`.trim();
        }
      }

      agences.push({
        id: a.id, nom: a.nom, ville: a.ville, adresse: a.adresse,
        telephone: a.telephone, pdg, createdAt: a.createdAt,
        pdvActifs: pdvSnap.size, essai: a.essai || null,
      });
    }

    return res.status(200).json({ agences });
  } catch (err) {
    console.error('Erreur liste agences admin :', err);
    return res.status(500).json({ message: 'Erreur serveur.' });
  }
});

// ════════════════════════════════
//  SUSPENDRE / RÉACTIVER
//  PATCH /admin/agence/:agenceId/statut
// ════════════════════════════════
router.patch('/agence/:agenceId/statut', async (req, res) => {
  const { agenceId } = req.params;
  const { adminKey, actif } = req.body;

  if (adminKey !== process.env.ADMIN_SECRET_KEY) {
    return res.status(403).json({ message: 'Non autorisé.' });
  }
  if (typeof actif !== 'boolean') {
    return res.status(400).json({ message: 'actif doit être true ou false.' });
  }

  try {
    const docRef = firestore.collection('agences').doc(agenceId);
    const doc = await docRef.get();
    if (!doc.exists) return res.status(404).json({ message: 'Agence introuvable.' });

    if (actif) {
      await docRef.update({ 'essai.actif': true });
      return res.status(200).json({ message: 'Agence réactivée (accès débloqué).' });
    } else {
      await docRef.update({ 'essai.actif': false });
      return res.status(200).json({ message: 'Agence suspendue.' });
    }
  } catch (err) {
    console.error('Erreur statut admin agence :', err);
    return res.status(500).json({ message: 'Erreur serveur.' });
  }
});

module.exports = router;