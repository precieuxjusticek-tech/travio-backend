const express = require('express');
const router  = express.Router();

const { firestore } = require('../firebase');
const { checkEssai, essaiEstActif } = require('../helpers/essai');
const { verifierToken } = require('../middlewares/verifierToken');
const { verifierRole }  = require('../middlewares/verifierRole');

// ════════════════════════════════
//  UTIL — Génération code de retrait
//  (toujours généré côté serveur, jamais fait confiance au client)
// ════════════════════════════════
function genererCodeRetrait() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sans 0/O/1/I
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// ════════════════════════════════
//  CRÉER UN COLIS (EXPÉDITION PDV)
//  POST /colis/create
// ════════════════════════════════
router.post('/create', verifierToken, checkEssai, async (req, res) => {
  const {
    agenceId, pdvId, trajetId, routeLabel,
    sessionId, dateDepart, heureDepart, busNom,
    expediteurNom, expediteurTel,
    destinataireNom, destinataireTel,
    nature, poids, valeurDeclaree, remarques,
    prixTransport,
  } = req.body;

  if (req.user.agenceId !== agenceId) {
    return res.status(403).json({ message: 'Accès refusé à cette agence.' });
  }

  if (req.user.role === 'agent' && req.user.pdvId !== pdvId) {
    return res.status(403).json({ message: 'Vous ne pouvez enregistrer un colis que pour votre propre PDV.' });
  }

  if (!agenceId || !pdvId || !trajetId) {
    return res.status(400).json({ message: 'agenceId, pdvId et trajetId sont obligatoires.' });
  }
  if (!expediteurNom || !expediteurTel) {
    return res.status(400).json({ message: 'Informations expéditeur manquantes.' });
  }
  if (!destinataireNom || !destinataireTel) {
    return res.status(400).json({ message: 'Informations destinataire manquantes.' });
  }
  if (!nature) {
    return res.status(400).json({ message: 'La nature du colis est obligatoire.' });
  }
  if (!prixTransport || Number(prixTransport) <= 0) {
    return res.status(400).json({ message: 'Le prix du transport est obligatoire.' });
  }

  try {
    const pdvDoc = await firestore.collection('pointsDeVente').doc(pdvId).get();
    if (!pdvDoc.exists) return res.status(404).json({ message: 'PDV introuvable.' });
    if (req.user.agenceId !== pdvDoc.data().agenceId) {
      return res.status(403).json({ message: 'Accès refusé à ce PDV.' });
    }

    const trajetDoc = await firestore.collection('trajets').doc(trajetId).get();
    if (!trajetDoc.exists) {
      return res.status(404).json({ message: 'Trajet introuvable.' });
    }

    const codeRetrait = genererCodeRetrait();
    const colisRef = firestore.collection('colis').doc();
    const colisId  = colisRef.id;

    const data = {
      id: colisId,
      agenceId, pdvId, trajetId,
      routeLabel:  routeLabel  || null,
      sessionId:   sessionId   || null,
      dateDepart:  dateDepart  || null,
      heureDepart: heureDepart || null,
      busNom:      busNom      || null,

      expediteurNom,
      expediteurTel,
      destinataireNom,
      destinataireTel,

      nature,
      poids:          poids          != null ? Number(poids)          : null,
      valeurDeclaree: valeurDeclaree != null ? Number(valeurDeclaree) : null,
      remarques:      remarques      || null,

      prixTransport: Number(prixTransport),
      codeRetrait,
      statut: 'en_transit', // en_transit -> arrive -> retire
      pdvIdRetrait: null,
      retirePar:    null,
      dateRetrait:  null,

      createdAt: new Date().toISOString(),
    };

    await colisRef.set(data);

    return res.status(201).json({
      message:  'Colis enregistré avec succès.',
      id:       colisId,
      colisId,
      codeRetrait,
    });

  } catch (err) {
    console.error('Erreur création colis :', err);
    return res.status(500).json({ message: 'Erreur serveur, réessayez.' });
  }
});

// ════════════════════════════════
//  RÉCUPÉRER LES COLIS D'UN PDV
//  GET /colis?pdvId=xxx
// ════════════════════════════════
router.get('/', verifierToken, async (req, res) => {
  const { pdvId } = req.query;
  if (!pdvId) {
    return res.status(400).json({ message: 'pdvId manquant.' });
  }
  try {
    const pdvDoc = await firestore.collection('pointsDeVente').doc(pdvId).get();
    if (!pdvDoc.exists) return res.status(404).json({ message: 'PDV introuvable.' });
    if (req.user.agenceId !== pdvDoc.data().agenceId) {
      return res.status(403).json({ message: 'Accès refusé à ce PDV.' });
    }

    if (req.user.role === 'agent' && req.user.pdvId !== pdvId) {
      return res.status(403).json({ message: 'Accès refusé à ce PDV.' });
    }

    const snapshot = await firestore
      .collection('colis')
      .where('pdvId', '==', pdvId)
      .orderBy('createdAt', 'desc')
      .get();

    const colis = snapshot.docs.map(doc => doc.data());
    return res.status(200).json({ colis });

  } catch (err) {
    console.error('Erreur récupération colis :', err);
    return res.status(500).json({ message: 'Erreur serveur, réessayez.' });
  }
});

// ════════════════════════════════
//  RÉCUPÉRER TOUS LES COLIS D'UNE AGENCE
//  GET /colis/agence?agenceId=xxx
// ════════════════════════════════
router.get('/agence', verifierToken, verifierRole('admin'), async (req, res) => {
  const { agenceId } = req.query;

  if (!agenceId) {
    return res.status(400).json({ message: 'agenceId manquant.' });
  }

  if (req.user.agenceId !== agenceId) {
    return res.status(403).json({ message: 'Accès refusé à cette agence.' });
  }

  try {
    const snapshot = await firestore
      .collection('colis')
      .where('agenceId', '==', agenceId)
      .orderBy('createdAt', 'desc')
      .get();

    const colis = snapshot.docs.map(doc => doc.data());
    return res.status(200).json({ colis });

  } catch (err) {
    console.error('Erreur récupération colis agence :', err);
    return res.status(500).json({ message: 'Erreur serveur, réessayez.' });
  }
});

// ════════════════════════════════
//  VÉRIFIER UN CODE DE RETRAIT
//  GET /colis/verifier/:code
// ════════════════════════════════
router.get('/verifier/:code', verifierToken, async (req, res) => {
  const code = (req.params.code || '').toUpperCase().trim();

  try {
    const snapshot = await firestore
      .collection('colis')
      .where('codeRetrait', '==', code)
      .limit(1)
      .get();

    if (snapshot.empty) {
      return res.status(404).json({ message: 'Code invalide ou colis introuvable.' });
    }

    const colisDoc = snapshot.docs[0];
    const colis = colisDoc.data();

    if (req.user.agenceId !== colis.agenceId) {
      return res.status(403).json({ message: 'Accès refusé à ce colis.' });
    }

    if (colis.statut === 'retire') {
      return res.status(409).json({ message: 'Ce colis a déjà été retiré.', colis });
    }

    return res.status(200).json({ colis });

  } catch (err) {
    console.error('Erreur vérification code colis :', err);
    return res.status(500).json({ message: 'Erreur serveur, réessayez.' });
  }
});

// ════════════════════════════════
//  CHANGER LE STATUT D'UN COLIS
//  PATCH /colis/:id/statut
//  body : { statut, pdvIdRetrait?, retirePar? }
// ════════════════════════════════
router.patch('/:id/statut', verifierToken, async (req, res) => {
  const { id } = req.params;
  const { statut, pdvIdRetrait, retirePar } = req.body;
  const statutsValides = ['en_transit', 'arrive', 'retire'];

  if (!statutsValides.includes(statut)) {
    return res.status(400).json({ message: 'Statut invalide.' });
  }

  try {
    const docRef = firestore.collection('colis').doc(id);
    const doc = await docRef.get();
    if (!doc.exists) return res.status(404).json({ message: 'Colis introuvable.' });

    const colis = doc.data();
    if (req.user.agenceId !== colis.agenceId) {
      return res.status(403).json({ message: 'Accès refusé à ce colis.' });
    }

    if (req.user.role === 'agent' && req.user.pdvId !== colis.pdvId && req.user.pdvId !== pdvIdRetrait) {
      return res.status(403).json({ message: 'Accès refusé à ce colis.' });
    }

    if (!(await essaiEstActif(colis.agenceId))) {
      return res.status(403).json({ message: "Période d'essai expirée.", code: 'ESSAI_EXPIRE' });
    }

    if (colis.statut === 'retire') {
      return res.status(409).json({ message: 'Ce colis a déjà été retiré.' });
    }

    const update = { statut, updatedAt: new Date().toISOString() };
    if (statut === 'retire') {
      update.pdvIdRetrait = pdvIdRetrait || null;
      update.retirePar    = retirePar    || null;
      update.dateRetrait  = new Date().toISOString();
    }

    await docRef.update(update);
    const updated = await docRef.get();

    return res.status(200).json({ message: 'Statut mis à jour.', colis: updated.data() });

  } catch (err) {
    console.error('Erreur mise à jour statut colis :', err);
    return res.status(500).json({ message: 'Erreur serveur, réessayez.' });
  }
});

module.exports = router;