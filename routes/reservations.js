const express = require('express');
const router  = express.Router();
const { essaiEstActif } = require('../helpers/essai');

const { firestore } = require('../firebase');
const { checkEssai } = require('../helpers/essai');
const { getSegmentsTrajet } = require('../helpers/segments');
const { verifierToken } = require('../middlewares/verifierToken');
const { verifierRole } = require('../middlewares/verifierRole');

async function enrichirBusSupprime(reservations) {
  const sessionIds = [...new Set(reservations.map(r => r.sessionId).filter(Boolean))];
  if (sessionIds.length === 0) return reservations;

  const refs = sessionIds.map(id => firestore.collection('sessions').doc(id));
  const docs = await firestore.getAll(...refs);

  const sessionsMap = new Map();
  docs.forEach(doc => {
    if (doc.exists) {
      const s = doc.data();
      if (s.departSupprime) {
        sessionsMap.set(doc.id, s.departNom || null);
      }
    }
  });

  return reservations.map(r => {
    if (r.sessionId && sessionsMap.has(r.sessionId)) {
      return { ...r, busSupprime: true, busNomSupprime: sessionsMap.get(r.sessionId) || r.busNom || null };
    }
    return r;
  });
}

// ════════════════════════════════
//  CRÉER UNE RÉSERVATION (VENTE PDV)
//  POST /reservations/create
// ════════════════════════════════
router.post('/create', verifierToken, checkEssai, async (req, res) => {
  const {
    agenceId, pdvId, trajetId, sessionId,
    typeTrajet, routeLabel, heureDepart, dateDepart,
    arretMontee, arretDescente,
    prenomPassager, nomPassager, telephonePassager,
    typeBillet, bagages, siege, prixBillet, prixBagages,
    passagers, nbPassagers, prixTotal, remarques,
  } = req.body;

  if (req.user.agenceId !== agenceId) {
    return res.status(403).json({ message: 'Accès refusé à cette agence.' });
  }

  if (req.user.role === 'agent' && req.user.pdvId !== pdvId) {
    return res.status(403).json({ message: 'Vous ne pouvez vendre que pour votre propre PDV.' });
  }

  if (!agenceId || !trajetId || !sessionId || !dateDepart || !prenomPassager || !prixTotal) {
    return res.status(400).json({ message: 'Champs obligatoires manquants.' });
  }
  if (typeof prenomPassager !== 'string' || prenomPassager.trim().length < 2 || prenomPassager.length > 100) {
    return res.status(400).json({ message: 'Prénom du passager invalide.' });
  }
  if (nomPassager !== undefined && nomPassager !== null && (typeof nomPassager !== 'string' || nomPassager.length > 100)) {
    return res.status(400).json({ message: 'Nom du passager invalide.' });
  }
  if (telephonePassager !== undefined && telephonePassager !== null && telephonePassager !== '' && (typeof telephonePassager !== 'string' || !/^\+?[0-9]{6,15}$/.test(telephonePassager.replace(/\s/g, '')))) {
    return res.status(400).json({ message: 'Téléphone du passager invalide.' });
  }
  if (typeof dateDepart !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateDepart)) {
    return res.status(400).json({ message: 'Date de départ invalide.' });
  }
  const nbPassagersNum = nbPassagers !== undefined ? Number(nbPassagers) : 1;
  if (!Number.isInteger(nbPassagersNum) || nbPassagersNum <= 0 || nbPassagersNum > 50) {
    return res.status(400).json({ message: 'nbPassagers invalide.' });
  }
  const prixTotalNum = Number(prixTotal);
  if (!Number.isFinite(prixTotalNum) || prixTotalNum < 0) {
    return res.status(400).json({ message: 'prixTotal invalide.' });
  }
  if (prixBillet !== undefined && prixBillet !== null && !Number.isFinite(Number(prixBillet))) {
    return res.status(400).json({ message: 'prixBillet invalide.' });
  }
  if (prixBagages !== undefined && prixBagages !== null && !Number.isFinite(Number(prixBagages))) {
    return res.status(400).json({ message: 'prixBagages invalide.' });
  }
  if (bagages !== undefined && bagages !== null && !Number.isFinite(Number(bagages))) {
    return res.status(400).json({ message: 'bagages invalide.' });
  }
  if (passagers !== undefined && !Array.isArray(passagers)) {
    return res.status(400).json({ message: 'passagers doit être un tableau.' });
  }

  try {
    let pdvNomVente = 'Vente directe — Siège';

    if (pdvId) {
      const pdvDoc = await firestore.collection('pointsDeVente').doc(pdvId).get();
      if (!pdvDoc.exists) return res.status(404).json({ message: 'PDV introuvable.' });
      if (req.user.agenceId !== pdvDoc.data().agenceId) {
        return res.status(403).json({ message: 'Accès refusé à ce PDV.' });
      }
      pdvNomVente = pdvDoc.data().nom || pdvNomVente;
    }

    const trajetDoc = await firestore.collection('trajets').doc(trajetId).get();
    if (!trajetDoc.exists) {
      return res.status(404).json({ message: 'Trajet introuvable.' });
    }
    const trajet = trajetDoc.data();

    const segInfo = getSegmentsTrajet(trajet, arretMontee, arretDescente);
    if (!segInfo) {
      return res.status(400).json({ message: 'Segment de trajet invalide (descente avant montée ?).' });
    }
    const { segments, nbSegments } = segInfo;

    const nbBillets = nbPassagersNum;
    const resaRef = firestore.collection('reservations').doc();
    const resaId  = resaRef.id;

    try {
      await firestore.runTransaction(async (t) => {
        const sessionRef  = firestore.collection('sessions').doc(sessionId);
        const sessionSnap = await t.get(sessionRef);

        if (!sessionSnap.exists) {
          const err = new Error('Session introuvable.');
          err.code = 404;
          throw err;
        }
        const session = sessionSnap.data();

        if (session.statut === 'annulée') {
          const err = new Error('Cette session a été annulée, impossible de vendre une place.');
          err.code = 409;
          throw err;
        }

        const placesVenduesSegments = session.placesVenduesSegments && session.placesVenduesSegments.length === nbSegments
          ? session.placesVenduesSegments
          : Array(nbSegments).fill(session.placesVendues || 0);

        for (const segIdx of segments) {
          const occupees = placesVenduesSegments[segIdx] || 0;
          if (occupees + nbBillets > session.placesTotal) {
            const err = new Error(`Plus assez de places sur ce tronçon. Disponibles : ${session.placesTotal - occupees}, demandés : ${nbBillets}.`);
            err.code = 409;
            throw err;
          }
        }

        const newSegments = [...placesVenduesSegments];
        segments.forEach(segIdx => {
          newSegments[segIdx] = (newSegments[segIdx] || 0) + nbBillets;
        });

        t.set(resaRef, {
          id: resaId,
          agenceId, pdvId: pdvId || null, pdvVendeurNom: pdvNomVente, trajetId, sessionId,
          typeTrajet:        typeTrajet   || 'direct',
          routeLabel:        routeLabel   || null,
          heureDepart:       heureDepart  || null,
          busNom:            req.body.busNom || null,
          dateDepart,
          arretMontee:       arretMontee  || null,
          arretDescente:     arretDescente || null,
          prenomPassager,
          nomPassager:       nomPassager  || null,
          telephonePassager: telephonePassager || null,
          typeBillet:        typeBillet   || 'adulte',
          typeBilletNom:     req.body.typeBilletNom || null,
          bagages:           bagages      || 0,
          siege:             siege        || null,
          prixBillet:        prixBillet   || 0,
          prixBagages:       prixBagages  || 0,
          passagers:         passagers    || [],
          nbPassagers:       nbBillets,
          prixTotal:         prixTotalNum,
          remarques:         remarques    || null,
          pdvEmbarquementId:    req.body.pdvEmbarquementId    || null,
          pdvEmbarquementNom:   req.body.pdvEmbarquementNom   || null,
          pdvEmbarquementVille: req.body.pdvEmbarquementVille || null,
          pdvDebarquementId:    req.body.pdvDebarquementId    || null,
          pdvDebarquementNom:   req.body.pdvDebarquementNom   || null,
          pdvDebarquementVille: req.body.pdvDebarquementVille || null,
          statut:            'confirmée',
          createdAt:         new Date().toISOString(),
        });

        t.update(sessionRef, {
          placesVenduesSegments: newSegments,
          placesVendues:   (session.placesVendues || 0) + nbBillets,
          placesRestantes: session.placesTotal - Math.max(...newSegments),
          updatedAt:       new Date().toISOString(),
        });
      });
    } catch (txErr) {
      if (txErr.code === 404) return res.status(404).json({ message: txErr.message });
      if (txErr.code === 409) return res.status(409).json({ message: txErr.message });
      throw txErr;
    }

    return res.status(201).json({
      message:       'Réservation créée avec succès.',
      reservationId: resaId,
      id:            resaId,
    });

  } catch (err) {
    console.error('Erreur création réservation :', err);
    return res.status(500).json({ message: 'Erreur serveur, réessayez.' });
  }
});

// ════════════════════════════════
//  RÉCUPÉRER LES RÉSERVATIONS D'UN PDV
//  GET /reservations?pdvId=xxx
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
      .collection('reservations')
      .where('pdvId', '==', pdvId)
      .orderBy('createdAt', 'desc')
      .get();

    const reservations = snapshot.docs.map(doc => doc.data());
    return res.status(200).json({ reservations });
  } catch (err) {
    console.error('Erreur récupération réservations :', err);
    return res.status(500).json({ message: 'Erreur serveur, réessayez.' });
  }
});

// ════════════════════════════════
//  RÉCUPÉRER TOUTES LES RÉSERVATIONS D'UNE AGENCE
//  GET /reservations/agence?agenceId=xxx
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
      .collection('reservations')
      .where('agenceId', '==', agenceId)
      .orderBy('createdAt', 'desc')
      .get();

    let reservations = snapshot.docs.map(doc => doc.data());
    reservations = await enrichirBusSupprime(reservations); // 👈 ligne ajoutée (manquait)

    return res.status(200).json({ reservations });

  } catch (err) {
    console.error('Erreur récupération réservations agence :', err);
    return res.status(500).json({ message: 'Erreur serveur, réessayez.' });
  }
});

// ════════════════════════════════
//  ANNULATION D'UN BILLET
//  PATCH /reservations/:resaId/annuler
// ════════════════════════════════
router.patch('/:resaId/annuler', verifierToken, async (req, res) => {
  const { resaId } = req.params;
  const { pdvId }  = req.body;
  const OFFSET_MS  = 1 * 60 * 60 * 1000;

  try {
    const doc = await firestore.collection('reservations').doc(resaId).get();
    if (!doc.exists) return res.status(404).json({ message: 'Réservation introuvable.' });

    const r = doc.data();
    if (req.user.agenceId !== r.agenceId) {
      return res.status(403).json({ message: 'Accès refusé à cette réservation.' });
    }
    if (r.statut === 'annulée') return res.status(409).json({ message: 'Déjà annulée.' });

    if (!(await essaiEstActif(r.agenceId))) {
      return res.status(403).json({ message: "Période d'essai expirée.", code: 'ESSAI_EXPIRE' });
    }

    if (req.user.role === 'agent' && r.pdvId !== req.user.pdvId) {
      return res.status(403).json({ message: 'Vous ne pouvez pas annuler cette réservation.' });
    }

    if (r.dateDepart && r.heureDepart) {
      const departInstant = new Date(`${r.dateDepart}T${r.heureDepart}:00Z`).getTime() - OFFSET_MS;
      if (departInstant < Date.now()) {
        return res.status(409).json({ message: 'Ce voyage a déjà eu lieu — annulation impossible.' });
      }
    }

    const agenceDoc = await firestore.collection('agences').doc(r.agenceId).get();
    const politique = agenceDoc.exists ? agenceDoc.data().politiqueAnnulation : null;

    if (!politique || !politique.autorise) {
      return res.status(403).json({ message: 'Vente définitive — annulation impossible.' });
    }

    let horsDelai = false;
    if (politique.delaiHeures && r.dateDepart && r.heureDepart) {
      const departInstant = new Date(`${r.dateDepart}T${r.heureDepart}:00Z`).getTime() - OFFSET_MS;
      const diffHeures    = (departInstant - Date.now()) / (1000 * 60 * 60);
      if (diffHeures < politique.delaiHeures) horsDelai = true;
    }

    const prixTotal = Number(r.prixTotal || 0);
    let frais = prixTotal, montantRembourse = 0;

    if (politique.remboursement && !horsDelai) {
      const fraisPct   = politique.precisions || 0;
      frais            = Math.round(prixTotal * fraisPct / 100);
      montantRembourse = prixTotal - frais;
    }

    // Le trajet ne change pas pendant l'annulation, on peut le lire hors transaction
    const trajetDocAnnul = r.trajetId
      ? await firestore.collection('trajets').doc(r.trajetId).get()
      : null;
    const trajetAnnul = trajetDocAnnul && trajetDocAnnul.exists ? trajetDocAnnul.data() : null;
    const nbBilletsAnnul = r.nbPassagers || 1;

    await firestore.runTransaction(async (t) => {
      const resaRef = firestore.collection('reservations').doc(resaId);

      let sessionRef = null;
      let session    = null;
      if (r.sessionId) {
        sessionRef = firestore.collection('sessions').doc(r.sessionId);
        const sessionSnap = await t.get(sessionRef);
        if (sessionSnap.exists) session = sessionSnap.data();
      }

      t.update(resaRef, {
        statut:           'annulée',
        annuleeAt:        new Date().toISOString(),
        fraisRetenus:     frais,
        montantRembourse,
      });

      if (session && trajetAnnul) {
        const segInfo = getSegmentsTrajet(trajetAnnul, r.arretMontee, r.arretDescente);
        if (segInfo) {
          const { segments, nbSegments } = segInfo;

          const placesVenduesSegments = session.placesVenduesSegments &&
            session.placesVenduesSegments.length === nbSegments
              ? session.placesVenduesSegments
              : Array(nbSegments).fill(session.placesVendues || 0);

          const newSegments = [...placesVenduesSegments];
          segments.forEach(segIdx => {
            newSegments[segIdx] = Math.max(0, (newSegments[segIdx] || 0) - nbBilletsAnnul);
          });

          t.update(sessionRef, {
            placesVenduesSegments: newSegments,
            placesVendues:   Math.max(0, (session.placesVendues || 0) - nbBilletsAnnul),
            placesRestantes: session.placesTotal - Math.max(0, ...newSegments),
            updatedAt:       new Date().toISOString(),
          });
        }
      }
    });

    if (r.pdvId) {
      const pdvDoc = await firestore.collection('pointsDeVente').doc(r.pdvId).get();
      if (pdvDoc.exists) {
        const annulationsActuelles = pdvDoc.data().annulations || 0;
        await firestore.collection('pointsDeVente').doc(r.pdvId).update({
          annulations: annulationsActuelles + (r.nbPassagers || 1),
          updatedAt:   new Date().toISOString(),
        });
      }
    }

    return res.status(200).json({
      message: 'Réservation annulée.',
      montantRembourse,
      fraisRetenus: frais,
    });

  } catch (err) {
    console.error('Erreur annulation réservation :', err);
    return res.status(500).json({ message: 'Erreur serveur.' });
  }
});

// ════════════════════════════════
//  RETIRER UN PASSAGER
//  PATCH /reservations/:resaId/retirer-passager
// ════════════════════════════════
router.patch('/:resaId/retirer-passager', verifierToken, async (req, res) => {
  const { resaId } = req.params;
  const { passagerIndex } = req.body;
  const OFFSET_MS = 1 * 60 * 60 * 1000;

  if (typeof passagerIndex !== 'number' || passagerIndex < 0) {
    return res.status(400).json({ message: 'passagerIndex invalide.' });
  }

  try {
    const doc = await firestore.collection('reservations').doc(resaId).get();
    if (!doc.exists) return res.status(404).json({ message: 'Réservation introuvable.' });

    const r = doc.data();
    if (req.user.agenceId !== r.agenceId) {
      return res.status(403).json({ message: 'Accès refusé à cette réservation.' });
    }

    if (req.user.role === 'agent' && r.pdvId !== req.user.pdvId) {
      return res.status(403).json({ message: 'Vous ne pouvez pas modifier cette réservation.' });
    }

    if (r.statut === 'annulée') return res.status(409).json({ message: 'Cette réservation est déjà annulée.' });

    if (!(await essaiEstActif(r.agenceId))) {
      return res.status(403).json({ message: "Période d'essai expirée.", code: 'ESSAI_EXPIRE' });
    }

    if (r.dateDepart && r.heureDepart) {
      const departInstant = new Date(`${r.dateDepart}T${r.heureDepart}:00Z`).getTime() - OFFSET_MS;
      if (departInstant < Date.now()) {
        return res.status(409).json({ message: 'Ce voyage a déjà eu lieu — retrait impossible.' });
      }
    }

    if (!Array.isArray(r.passagers) || r.passagers.length <= 1) {
      return res.status(400).json({ message: 'Un seul passager sur ce billet — utilisez l\'annulation complète.' });
    }
    if (passagerIndex >= r.passagers.length) {
      return res.status(400).json({ message: 'passagerIndex hors limites.' });
    }

    const passagerRetire = r.passagers[passagerIndex];

    const agenceDoc = await firestore.collection('agences').doc(r.agenceId).get();
    const politique = agenceDoc.exists ? agenceDoc.data().politiqueAnnulation : null;

    if (!politique || !politique.autorise) {
      return res.status(403).json({ message: 'Vente définitive — retrait impossible.' });
    }

    let horsDelai = false;
    if (politique.delaiHeures && r.dateDepart && r.heureDepart) {
      const departInstant = new Date(`${r.dateDepart}T${r.heureDepart}:00Z`).getTime() - OFFSET_MS;
      const diffHeures    = (departInstant - Date.now()) / (1000 * 60 * 60);
      if (diffHeures < politique.delaiHeures) horsDelai = true;
    }

    const sousTotal = Number(passagerRetire.sousTotal || 0);
    let frais = sousTotal, montantRembourse = 0;

    if (politique.remboursement && !horsDelai) {
      const fraisPct   = politique.precisions || 0;
      frais            = Math.round(sousTotal * fraisPct / 100);
      montantRembourse = sousTotal - frais;
    }

    const nouveauxPassagers = [...r.passagers];
    nouveauxPassagers.splice(passagerIndex, 1);

    const updateData = {
      passagers:   nouveauxPassagers,
      prixTotal:   Math.max(0, Number(r.prixTotal || 0) - sousTotal),
      nbPassagers: Math.max(0, (r.nbPassagers || r.passagers.length) - 1),
      updatedAt:   new Date().toISOString(),
      passagerRetire: true,
      historiqueRetraits: [
        ...(r.historiqueRetraits || []),
        {
          nom: `${passagerRetire.prenom || ''} ${passagerRetire.nom || ''}`.trim(),
          montantRembourse,
          fraisRetenus: frais,
          retireAt: new Date().toISOString(),
        },
      ],
    };

    if (passagerIndex === 0) {
      const nouveauPrincipal = nouveauxPassagers[0];
      updateData.prenomPassager    = nouveauPrincipal.prenom    || null;
      updateData.nomPassager       = nouveauPrincipal.nom       || null;
      updateData.telephonePassager = nouveauPrincipal.telephone || null;
      updateData.typeBillet        = nouveauPrincipal.type      || null;
    }

    const trajetDocRetrait = r.trajetId
      ? await firestore.collection('trajets').doc(r.trajetId).get()
      : null;
    const trajetRetrait = trajetDocRetrait && trajetDocRetrait.exists ? trajetDocRetrait.data() : null;

    await firestore.runTransaction(async (t) => {
      const resaRef = firestore.collection('reservations').doc(resaId);

      let sessionRef = null;
      let session    = null;
      if (r.sessionId && r.trajetId) {
        sessionRef = firestore.collection('sessions').doc(r.sessionId);
        const sessionSnap = await t.get(sessionRef);
        if (sessionSnap.exists) session = sessionSnap.data();
      }

      t.update(resaRef, updateData);

      if (session && trajetRetrait) {
        const segInfo = getSegmentsTrajet(trajetRetrait, r.arretMontee, r.arretDescente);
        if (segInfo) {
          const { segments, nbSegments } = segInfo;
          const placesVenduesSegments = session.placesVenduesSegments &&
            session.placesVenduesSegments.length === nbSegments
              ? session.placesVenduesSegments
              : Array(nbSegments).fill(session.placesVendues || 0);

          const newSegments = [...placesVenduesSegments];
          segments.forEach(segIdx => {
            newSegments[segIdx] = Math.max(0, (newSegments[segIdx] || 0) - 1);
          });

          t.update(sessionRef, {
            placesVenduesSegments: newSegments,
            placesVendues:   Math.max(0, (session.placesVendues || 0) - 1),
            placesRestantes: session.placesTotal - Math.max(0, ...newSegments),
            updatedAt:       new Date().toISOString(),
          });
        }
      }
    });

    if (r.pdvId) {
      const pdvDoc = await firestore.collection('pointsDeVente').doc(r.pdvId).get();
      if (pdvDoc.exists) {
        const annulationsActuelles = pdvDoc.data().annulations || 0;
        await firestore.collection('pointsDeVente').doc(r.pdvId).update({
          annulations: annulationsActuelles + 1,
          updatedAt:   new Date().toISOString(),
        });
      }
    }

    return res.status(200).json({
      message: 'Passager retiré.',
      montantRembourse,
      fraisRetenus: frais,
      reservation: { ...r, ...updateData },
    });

  } catch (err) {
    console.error('Erreur retrait passager :', err);
    return res.status(500).json({ message: 'Erreur serveur.' });
  }
});

// ════════════════════════════════
//  MODIFICATION D'UN BILLET
//  PATCH /reservations/:resaId
// ════════════════════════════════
router.patch('/:resaId', verifierToken, async (req, res) => {
  const { resaId } = req.params;
  const {
    prenomPassager, nomPassager, telephonePassager,
    typeBillet, bagages, prixBillet, prixBagages,
    arretMontee, arretDescente, passagers, nbPassagers,
    prixTotal, remarques, routeLabel,
    pdvEmbarquementId, pdvEmbarquementNom, pdvEmbarquementVille,
    pdvDebarquementId, pdvDebarquementNom, pdvDebarquementVille,
    raisonModification,
  } = req.body;
  const OFFSET_MS = 1 * 60 * 60 * 1000;

  if (!prenomPassager || !prixTotal) {
    return res.status(400).json({ message: 'Champs obligatoires manquants.' });
  }
  if (typeof prenomPassager !== 'string' || prenomPassager.trim().length < 2 || prenomPassager.length > 100) {
    return res.status(400).json({ message: 'Prénom du passager invalide.' });
  }
  if (nomPassager !== undefined && nomPassager !== null && (typeof nomPassager !== 'string' || nomPassager.length > 100)) {
    return res.status(400).json({ message: 'Nom du passager invalide.' });
  }
  if (telephonePassager !== undefined && telephonePassager !== null && telephonePassager !== '' && (typeof telephonePassager !== 'string' || !/^\+?[0-9]{6,15}$/.test(telephonePassager.replace(/\s/g, '')))) {
    return res.status(400).json({ message: 'Téléphone du passager invalide.' });
  }
  const prixTotalNum = Number(prixTotal);
  if (!Number.isFinite(prixTotalNum) || prixTotalNum < 0) {
    return res.status(400).json({ message: 'prixTotal invalide.' });
  }
  if (nbPassagers !== undefined && (!Number.isInteger(Number(nbPassagers)) || Number(nbPassagers) <= 0)) {
    return res.status(400).json({ message: 'nbPassagers invalide.' });
  }
  if (passagers !== undefined && !Array.isArray(passagers)) {
    return res.status(400).json({ message: 'passagers doit être un tableau.' });
  }

  try {
    const doc = await firestore.collection('reservations').doc(resaId).get();
    if (!doc.exists) return res.status(404).json({ message: 'Réservation introuvable.' });

    const r = doc.data();
    if (req.user.agenceId !== r.agenceId) {
      return res.status(403).json({ message: 'Accès refusé à cette réservation.' });
    }

    if (req.user.role === 'agent' && r.pdvId !== req.user.pdvId) {
      return res.status(403).json({ message: 'Vous ne pouvez pas modifier cette réservation.' });
    }

    if (r.statut === 'annulée') {
      return res.status(409).json({ message: 'Impossible de modifier une réservation annulée.' });
    }

    if (!(await essaiEstActif(r.agenceId))) {
      return res.status(403).json({ message: "Période d'essai expirée.", code: 'ESSAI_EXPIRE' });
    }

    if (r.dateDepart && r.heureDepart) {
      const departInstant = new Date(`${r.dateDepart}T${r.heureDepart}:00Z`).getTime() - OFFSET_MS;
      if (departInstant < Date.now()) {
        return res.status(409).json({ message: 'Ce voyage a déjà eu lieu — modification impossible.' });
      }
    }

    if (r.modifiee === true) {
      return res.status(409).json({ message: 'Cette réservation a déjà été modifiée une fois — modification impossible.' });
    }

    const ancienPrixTotal  = Number(r.prixTotal || 0);
    const nouveauPrixTotal = Number(prixTotal);
    const prixEnBaisse     = nouveauPrixTotal < ancienPrixTotal;

    if (prixEnBaisse && !raisonModification) {
      return res.status(400).json({ message: 'La raison de la modification est obligatoire en cas de baisse de prix.' });
    }

    const nouveauMontee   = arretMontee   !== undefined ? arretMontee   : r.arretMontee;
    const nouveauDescente = arretDescente !== undefined ? arretDescente : r.arretDescente;
    const nouveauNb       = nbPassagers   !== undefined ? Number(nbPassagers) : r.nbPassagers;

    const segmentsOntChange =
      nouveauMontee   !== r.arretMontee ||
      nouveauDescente !== r.arretDescente ||
      nouveauNb       !== r.nbPassagers;

    const updateData = {
      prenomPassager,
      nomPassager:       nomPassager       || null,
      telephonePassager: telephonePassager || null,
      typeBillet:        typeBillet        || r.typeBillet,
      bagages:           bagages           ?? r.bagages,
      prixBillet:        prixBillet        ?? r.prixBillet,
      prixBagages:       prixBagages       ?? r.prixBagages,
      arretMontee:       nouveauMontee,
      arretDescente:     nouveauDescente,
      nbPassagers:       nouveauNb,
      passagers:         passagers         || r.passagers,
      prixTotal:         prixTotalNum,
      remarques:         remarques         !== undefined ? remarques : r.remarques,
      routeLabel:        routeLabel        || r.routeLabel,
      pdvEmbarquementId:    pdvEmbarquementId    !== undefined ? pdvEmbarquementId    : r.pdvEmbarquementId,
      pdvEmbarquementNom:   pdvEmbarquementNom   !== undefined ? pdvEmbarquementNom   : r.pdvEmbarquementNom,
      pdvEmbarquementVille: pdvEmbarquementVille !== undefined ? pdvEmbarquementVille : r.pdvEmbarquementVille,
      pdvDebarquementId:    pdvDebarquementId    !== undefined ? pdvDebarquementId    : r.pdvDebarquementId,
      pdvDebarquementNom:   pdvDebarquementNom   !== undefined ? pdvDebarquementNom   : r.pdvDebarquementNom,
      pdvDebarquementVille: pdvDebarquementVille !== undefined ? pdvDebarquementVille : r.pdvDebarquementVille,
      updatedAt:          new Date().toISOString(),
      modifiee:           true,
      dateModification:   new Date().toISOString(),
      raisonModification: raisonModification || null,
      ...(prixEnBaisse
        ? { ecartMontant: ancienPrixTotal - nouveauPrixTotal, baisseNonVerifiee: true }
        : {}),
    };

    try {
      await firestore.runTransaction(async (t) => {
        const resaRef = firestore.collection('reservations').doc(resaId);

        if (segmentsOntChange && r.sessionId && r.trajetId) {
          const sessionRef = firestore.collection('sessions').doc(r.sessionId);
          const trajetRef  = firestore.collection('trajets').doc(r.trajetId);

          const [sessionSnap, trajetSnap] = await Promise.all([t.get(sessionRef), t.get(trajetRef)]);

          if (sessionSnap.exists && trajetSnap.exists) {
            const session = sessionSnap.data();
            const trajet  = trajetSnap.data();

            const ancienSeg  = getSegmentsTrajet(trajet, r.arretMontee, r.arretDescente);
            const nouveauSeg = getSegmentsTrajet(trajet, nouveauMontee, nouveauDescente);

            if (!nouveauSeg) {
              const err = new Error('Segment invalide (descente avant montée ?).');
              err.code = 400;
              throw err;
            }

            const nbSegments = nouveauSeg.nbSegments;
            let placesVenduesSegments = session.placesVenduesSegments && session.placesVenduesSegments.length === nbSegments
              ? [...session.placesVenduesSegments]
              : Array(nbSegments).fill(session.placesVendues || 0);

            if (ancienSeg) {
              ancienSeg.segments.forEach(idx => {
                placesVenduesSegments[idx] = Math.max(0, (placesVenduesSegments[idx] || 0) - (r.nbPassagers || 1));
              });
            }

            const anciensSegIds    = ancienSeg ? ancienSeg.segments : [];
            const segmentsNouveaux = nouveauSeg.segments.filter(idx => !anciensSegIds.includes(idx));

            for (const idx of segmentsNouveaux) {
              const occupees = placesVenduesSegments[idx] || 0;
              if (occupees + nouveauNb > session.placesTotal) {
                const err = new Error(`Plus assez de place sur le tronçon ajouté. Disponible : ${session.placesTotal - occupees}, demandé : ${nouveauNb}.`);
                err.code = 409;
                throw err;
              }
            }

            nouveauSeg.segments.forEach(idx => {
              placesVenduesSegments[idx] = (placesVenduesSegments[idx] || 0) + nouveauNb;
            });

            t.update(sessionRef, {
              placesVenduesSegments,
              placesRestantes: session.placesTotal - Math.max(0, ...placesVenduesSegments),
              updatedAt: new Date().toISOString(),
            });
          }
        }

        t.update(resaRef, updateData);
      });
    } catch (txErr) {
      if (txErr.code === 400) return res.status(400).json({ message: txErr.message });
      if (txErr.code === 409) return res.status(409).json({ message: txErr.message });
      throw txErr;
    }

    return res.status(200).json({ message: 'Réservation modifiée.', reservation: { ...r, ...updateData } });

  } catch (err) {
    console.error('Erreur modification réservation :', err);
    return res.status(500).json({ message: 'Erreur serveur.' });
  }
});

// ════════════════════════════════
//  MARQUER UNE BAISSE COMME VÉRIFIÉE
//  PATCH /reservations/:resaId/verifier-baisse
// ════════════════════════════════
router.patch('/:resaId/verifier-baisse', verifierToken, verifierRole('admin'), async (req, res) => {
  const { resaId } = req.params;
  try {
    const doc = await firestore.collection('reservations').doc(resaId).get();
    if (!doc.exists) return res.status(404).json({ message: 'Réservation introuvable.' });
    const r = doc.data();
    if (req.user.agenceId !== r.agenceId) {
      return res.status(403).json({ message: 'Accès refusé à cette réservation.' });
    }
    if (!(await essaiEstActif(r.agenceId))) {
      return res.status(403).json({ message: "Période d'essai expirée.", code: 'ESSAI_EXPIRE' });
    }

    await firestore.collection('reservations').doc(resaId).update({
      baisseNonVerifiee: false,
      verifieeAt: new Date().toISOString(),
    });

    return res.status(200).json({ message: 'Marqué comme vérifié.' });
  } catch (err) {
    console.error('Erreur vérification baisse :', err);
    return res.status(500).json({ message: 'Erreur serveur.' });
  }
});

module.exports = router;