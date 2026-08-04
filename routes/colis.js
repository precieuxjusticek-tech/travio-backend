const express = require('express');
const router  = express.Router();

const { firestore } = require('../firebase');
const { checkEssai, essaiEstActif } = require('../helpers/essai');
const { verifierToken } = require('../middlewares/verifierToken');
const { verifierRole }  = require('../middlewares/verifierRole');
const { verifierAccesChauffeur } = require('../middlewares/verifieracceschauffeur');

// ════════════════════════════════
//  UTIL — Génération code de retrait
//  (toujours généré côté serveur, jamais fait confiance au client)
// ════════════════════════════════
function genererCodeRetrait() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sans 0/O/1/I
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return `TRV-${code}`;
}

// ════════════════════════════════
//  CRÉER UN COLIS (EXPÉDITION PDV)
//  POST /colis/create
// ════════════════════════════════
router.post('/create', verifierToken, checkEssai, async (req, res) => {
  const {
    agenceId, pdvId, trajetId, routeLabel, typeTrajet,
    arretMontee, arretDescente,
    pdvEmbarquementId, pdvEmbarquementNom, pdvEmbarquementVille,
    pdvDebarquementId, pdvDebarquementNom, pdvDebarquementVille,
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
      typeTrajet:  typeTrajet  || 'direct',
      routeLabel:  routeLabel  || null,
      arretMontee:   arretMontee   || null,
      arretDescente: arretDescente || null,
      pdvEmbarquementId:    pdvEmbarquementId    || null,
      pdvEmbarquementNom:   pdvEmbarquementNom   || null,
      pdvEmbarquementVille: pdvEmbarquementVille || null,
      pdvDebarquementId:    pdvDebarquementId    || null,
      pdvDebarquementNom:   pdvDebarquementNom   || null,
      pdvDebarquementVille: pdvDebarquementVille || null,
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

      marqueArrivePar: null,
      dateArrivee:     null,

      typePieceIdentite:   null,
      numeroPieceIdentite: null,
      infoSansPiece:       null,

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
//  RÉCUPÉRER LES COLIS À RÉCEPTIONNER PAR UN PDV
//  GET /colis/a-receptionner?pdvId=xxx
// ════════════════════════════════
router.get('/a-receptionner', verifierToken, async (req, res) => {
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
      .where('pdvDebarquementId', '==', pdvId)
      .orderBy('createdAt', 'desc')
      .get();

    const colis = snapshot.docs.map(doc => doc.data());
    return res.status(200).json({ colis });

  } catch (err) {
    console.error('Erreur récupération colis à réceptionner :', err);
    return res.status(500).json({ message: 'Erreur serveur, réessayez.' });
  }
});

// ════════════════════════════════
//  VÉRIFIER UN CODE DE RETRAIT
//  GET /colis/verifier/:code
// ════════════════════════════════
router.get('/verifier/:code', verifierToken, async (req, res) => {
  let code = (req.params.code || '').toUpperCase().trim();
  if (code && !code.startsWith('TRV-')) code = `TRV-${code}`;

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

    if (req.user.role === 'agent' && req.user.pdvId !== colis.pdvDebarquementId) {
      return res.status(403).json({ message: "Ce colis n'est pas attendu à votre point de vente." });
    }

    if (colis.statut === 'retire') {
      return res.status(409).json({ message: 'Ce colis a déjà été retiré.', colis });
    }

    if (colis.statut === 'en_transit') {
      return res.status(409).json({ message: "Ce colis est encore en transit — il n'est pas encore arrivé à ce point de vente.", colis });
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
  const { statut, retirePar, marquePar, typePieceIdentite, numeroPieceIdentite, infoSansPiece } = req.body;
  const statutsValides = ['en_transit', 'arrive', 'retire'];
  const TYPES_PIECE_VALIDES = ['cni', 'passeport', 'permis', 'aucune'];

  if (!statutsValides.includes(statut)) {
    return res.status(400).json({ message: 'Statut invalide.' });
  }

  // Identité obligatoire avant tout retrait — validé côté serveur, jamais fait confiance au client
  if (statut === 'retire') {
    if (!retirePar || !retirePar.trim()) {
      return res.status(400).json({ message: 'Le nom de la personne qui retire le colis est obligatoire.' });
    }
    if (!typePieceIdentite || !TYPES_PIECE_VALIDES.includes(typePieceIdentite)) {
      return res.status(400).json({ message: "Le type de pièce d'identité est invalide ou manquant." });
    }
    if (typePieceIdentite === 'aucune') {
      if (!infoSansPiece || !infoSansPiece.trim()) {
        return res.status(400).json({ message: "En l'absence de pièce d'identité, une précision (motif, témoin...) est obligatoire." });
      }
    } else {
      if (!numeroPieceIdentite || !numeroPieceIdentite.trim()) {
        return res.status(400).json({ message: "Le numéro de la pièce d'identité est obligatoire." });
      }
    }
  }

  try {
    const docRef = firestore.collection('colis').doc(id);
    const doc = await docRef.get();
    if (!doc.exists) return res.status(404).json({ message: 'Colis introuvable.' });

    const colis = doc.data();
    if (req.user.agenceId !== colis.agenceId) {
      return res.status(403).json({ message: 'Accès refusé à ce colis.' });
    }

    if (req.user.role === 'agent') {
      if (!colis.pdvDebarquementId) {
        return res.status(400).json({ message: "Ce colis n'a pas de PDV de débarquement défini — impossible de mettre à jour son statut." });
      }
      if (req.user.pdvId !== colis.pdvDebarquementId) {
        return res.status(403).json({ message: 'Seul le point de vente de débarquement peut modifier le statut de ce colis.' });
      }
    }

    if (!(await essaiEstActif(colis.agenceId))) {
      return res.status(403).json({ message: "Période d'essai expirée.", code: 'ESSAI_EXPIRE' });
    }

    if (colis.statut === 'retire') {
      return res.status(409).json({ message: 'Ce colis a déjà été retiré.' });
    }

    if (statut === 'retire' && colis.statut !== 'arrive') {
      return res.status(409).json({ message: "Ce colis doit d'abord être marqué comme arrivé avant de pouvoir être retiré." });
    }

    const update = { statut, updatedAt: new Date().toISOString() };

    if (statut === 'arrive') {
      update.marqueArrivePar = marquePar || null;
      update.dateArrivee     = new Date().toISOString();
    }

    if (statut === 'retire') {
      update.pdvIdRetrait         = colis.pdvDebarquementId; // toujours le PDV de débarquement, jamais une valeur envoyée par le client
      update.retirePar            = retirePar.trim();
      update.typePieceIdentite    = typePieceIdentite;
      update.numeroPieceIdentite  = typePieceIdentite === 'aucune' ? null : numeroPieceIdentite.trim();
      update.infoSansPiece        = typePieceIdentite === 'aucune' ? infoSansPiece.trim() : null;
      update.dateRetrait          = new Date().toISOString();
    }

    await docRef.update(update);
    const updated = await docRef.get();

    return res.status(200).json({ message: 'Statut mis à jour.', colis: updated.data() });

  } catch (err) {
    console.error('Erreur mise à jour statut colis :', err);
    return res.status(500).json({ message: 'Erreur serveur, réessayez.' });
  }
});

// ════════════════════════════════════════════════════
//  ROUTES CHAUFFEUR — accès par lien partagé (sans JWT)
//  Utilisées uniquement par chauffeur.html
// ════════════════════════════════════════════════════

// ── VÉRIFIER UN CODE (chauffeur) ──
// GET /colis/chauffeur/verifier/:code?agenceId=xxx&token=xxx
router.get('/chauffeur/verifier/:code', verifierAccesChauffeur, async (req, res) => {
  let code = (req.params.code || '').toUpperCase().trim();
  if (code && !code.startsWith('TRV-')) code = `TRV-${code}`;

  try {
    const snapshot = await firestore
      .collection('colis')
      .where('codeRetrait', '==', code)
      .limit(1)
      .get();

    if (snapshot.empty) {
      return res.status(404).json({ message: 'Code invalide ou colis introuvable.' });
    }

    const colis = snapshot.docs[0].data();

    // req.agenceId vient du middleware, jamais du client directement
    if (colis.agenceId !== req.agenceId) {
      return res.status(403).json({ message: "Ce colis n'est pas rattaché à votre agence." });
    }

    // Le chauffeur ne peut agir que sur les colis sans PDV de débarquement (arrêt libre)
    // "__lieu_libre__" est un placeholder frontend, pas un vrai PDV — on le traite comme null
    if (colis.pdvDebarquementId && colis.pdvDebarquementId !== '__lieu_libre__') {
      return res.status(403).json({ message: "Ce colis doit être retiré via un point de vente, pas via ce lien chauffeur." });
    }

    if (colis.statut === 'retire') {
      return res.status(409).json({ message: 'Ce colis a déjà été retiré.', colis });
    }
    if (colis.statut === 'en_transit') {
      return res.status(409).json({ message: "Ce colis est encore en transit — il n'est pas encore arrivé.", colis });
    }

    return res.status(200).json({ colis });

  } catch (err) {
    console.error('Erreur vérification code colis (chauffeur) :', err);
    return res.status(500).json({ message: 'Erreur serveur, réessayez.' });
  }
});

// ── CHANGER LE STATUT D'UN COLIS (chauffeur) ──
// PATCH /colis/chauffeur/:id/statut?agenceId=xxx&token=xxx
// body : { statut: 'arrive' | 'retire', retirePar?, typePieceIdentite?, numeroPieceIdentite?, infoSansPiece? }
router.patch('/chauffeur/:id/statut', verifierAccesChauffeur, async (req, res) => {
  const { id } = req.params;
  const { statut, retirePar, typePieceIdentite, numeroPieceIdentite, infoSansPiece } = req.body;

  // Le chauffeur ne peut jamais remettre un colis "en_transit" — seulement faire avancer le statut
  const statutsValides = ['arrive', 'retire'];
  const TYPES_PIECE_VALIDES = ['cni', 'passeport', 'permis', 'aucune'];

  if (!statutsValides.includes(statut)) {
    return res.status(400).json({ message: 'Statut invalide.' });
  }

  if (statut === 'retire') {
    if (!retirePar || !retirePar.trim()) {
      return res.status(400).json({ message: 'Le nom de la personne qui retire le colis est obligatoire.' });
    }
    if (!typePieceIdentite || !TYPES_PIECE_VALIDES.includes(typePieceIdentite)) {
      return res.status(400).json({ message: "Le type de pièce d'identité est invalide ou manquant." });
    }
    if (typePieceIdentite === 'aucune') {
      if (!infoSansPiece || !infoSansPiece.trim()) {
        return res.status(400).json({ message: "En l'absence de pièce d'identité, une précision est obligatoire." });
      }
    } else {
      if (!numeroPieceIdentite || !numeroPieceIdentite.trim()) {
        return res.status(400).json({ message: "Le numéro de la pièce d'identité est obligatoire." });
      }
    }
  }

  try {
    const docRef = firestore.collection('colis').doc(id);
    const doc = await docRef.get();
    if (!doc.exists) return res.status(404).json({ message: 'Colis introuvable.' });

    const colis = doc.data();

    if (colis.agenceId !== req.agenceId) {
      return res.status(403).json({ message: 'Accès refusé à ce colis.' });
    }

    // Le chauffeur ne peut agir que sur les colis sans PDV de débarquement (arrêt libre)
    // "__lieu_libre__" est un placeholder frontend, pas un vrai PDV — on le traite comme null
    if (colis.pdvDebarquementId && colis.pdvDebarquementId !== '__lieu_libre__') {
      return res.status(403).json({ message: "Ce colis doit être retiré via un point de vente, pas via ce lien chauffeur." });
    }

    if (!(await essaiEstActif(colis.agenceId))) {
      return res.status(403).json({ message: "Période d'essai expirée.", code: 'ESSAI_EXPIRE' });
    }

    if (colis.statut === 'retire') {
      return res.status(409).json({ message: 'Ce colis a déjà été retiré.' });
    }
    if (statut === 'arrive' && colis.statut !== 'en_transit') {
      return res.status(409).json({ message: "Ce colis n'est pas en transit." });
    }
    if (statut === 'retire' && colis.statut !== 'arrive') {
      return res.status(409).json({ message: "Ce colis doit d'abord être marqué comme arrivé." });
    }

    const update = { statut, updatedAt: new Date().toISOString() };

    if (statut === 'arrive') {
      update.marqueArrivePar = 'chauffeur'; // pas d'identité individuelle, cf. note sécurité
      update.dateArrivee     = new Date().toISOString();
    }

    if (statut === 'retire') {
      update.pdvIdRetrait        = (colis.pdvDebarquementId && colis.pdvDebarquementId !== '__lieu_libre__') ? colis.pdvDebarquementId : null;
      update.retirePar           = retirePar.trim();
      update.typePieceIdentite   = typePieceIdentite;
      update.numeroPieceIdentite = typePieceIdentite === 'aucune' ? null : numeroPieceIdentite.trim();
      update.infoSansPiece       = typePieceIdentite === 'aucune' ? infoSansPiece.trim() : null;
      update.dateRetrait         = new Date().toISOString();
    }

    await docRef.update(update);
    const updated = await docRef.get();

    return res.status(200).json({ message: 'Statut mis à jour.', colis: updated.data() });

  } catch (err) {
    console.error('Erreur maj statut colis (chauffeur) :', err);
    return res.status(500).json({ message: 'Erreur serveur, réessayez.' });
  }
});

module.exports = router;