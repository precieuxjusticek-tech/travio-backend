const express = require('express');
const router  = express.Router();
const { essaiEstActif } = require('../helpers/essai');

const { firestore } = require('../firebase');
const { todayBrazza } = require('../helpers/dates');
const { getSegmentsTrajet } = require('../helpers/segments');
const { verifierToken } = require('../middlewares/verifierToken');
const { verifierRole } = require('../middlewares/verifierRole');
const { creerBatchAutoCommit } = require('../helpers/batch');
const { FieldValue } = require('firebase-admin/firestore');

// ════════════════════════════════
//  SESSIONS D'UN DÉPART
//  GET /sessions?departId=xxx
// ════════════════════════════════
router.get('/sessions', verifierToken, async (req, res) => {
  const { departId } = req.query;
  if (!departId) return res.status(400).json({ message: 'departId manquant.' });

  try {
    const departDoc = await firestore.collection('departs').doc(departId).get();
    if (!departDoc.exists) return res.status(404).json({ message: 'Départ introuvable.' });
    if (req.user.agenceId !== departDoc.data().agenceId) {
      return res.status(403).json({ message: 'Accès refusé à ce départ.' });
    }

    const todayStr = todayBrazza();

    const snapshot = await firestore
      .collection('sessions')
      .where('departId', '==', departId)
      .where('date', '>=', todayStr)
      .orderBy('date', 'asc')
      .get();

    return res.status(200).json({ sessions: snapshot.docs.map(d => d.data()) });
  } catch (err) {
    console.error('Erreur sessions :', err);
    return res.status(500).json({ message: 'Erreur serveur.' });
  }
});

// ════════════════════════════════
//  SUPPRIMER UNE SESSION
//  DELETE /session/:sessionId
// ════════════════════════════════
router.delete('/session/:sessionId', verifierToken, verifierRole('admin'), async (req, res) => {
  const { sessionId } = req.params;
  try {
    const doc = await firestore.collection('sessions').doc(sessionId).get();
    if (!doc.exists) return res.status(404).json({ message: 'Session introuvable.' });
    const session = doc.data();
    if (req.user.agenceId !== session.agenceId) {
      return res.status(403).json({ message: 'Accès refusé à cette session.' });
    }
    if (!(await essaiEstActif(session.agenceId))) {
      return res.status(403).json({ message: "Période d'essai expirée.", code: 'ESSAI_EXPIRE' });
    }

    await firestore.collection('sessions').doc(sessionId).delete();
    return res.status(200).json({ message: 'Session supprimée.' });
  } catch (err) {
    console.error('Erreur suppression session :', err);
    return res.status(500).json({ message: 'Erreur serveur.' });
  }
});

// ════════════════════════════════
//  MODIFIER UNE SESSION
//  PATCH /session/:sessionId
// ════════════════════════════════
router.patch('/session/:sessionId', verifierToken, verifierRole('admin'), async (req, res) => {
  const { sessionId } = req.params;
  const { arretsActifs, heureDepart, heureArrivee, dureeEstimee } = req.body;

  try {
    const doc = await firestore.collection('sessions').doc(sessionId).get();
    if (!doc.exists) return res.status(404).json({ message: 'Session introuvable.' });

    const session = doc.data();
    if (req.user.agenceId !== session.agenceId) {
      return res.status(403).json({ message: 'Accès refusé à cette session.' });
    }
    if (!(await essaiEstActif(session.agenceId))) {
      return res.status(403).json({ message: "Période d'essai expirée.", code: 'ESSAI_EXPIRE' });
    }
    if (session.statut === 'annulée') {
      return res.status(409).json({ message: 'Impossible de modifier une session annulée.' });
    }

    const updateData = {};
    if (arretsActifs !== undefined) {
      if (!Array.isArray(arretsActifs)) {
        return res.status(400).json({ message: 'arretsActifs doit être un tableau.' });
      }
      updateData.arretsActifs = arretsActifs;
    }
    if (heureDepart !== undefined) {
      if (heureDepart && !/^\d{2}:\d{2}$/.test(heureDepart)) {
        return res.status(400).json({ message: 'Heure de départ invalide.' });
      }
      updateData.heureDepart = heureDepart || null;
    }
    if (heureArrivee !== undefined) {
      if (heureArrivee && (typeof heureArrivee !== 'string' || !/^\d{2}:\d{2}$/.test(heureArrivee))) {
        return res.status(400).json({ message: 'Heure d\'arrivée invalide.' });
      }
      updateData.heureArrivee = heureArrivee || null;
    }
    if (dureeEstimee !== undefined) {
      if (dureeEstimee !== null && !Number.isFinite(Number(dureeEstimee))) {
        return res.status(400).json({ message: 'Durée estimée invalide.' });
      }
      updateData.dureeEstimee = dureeEstimee !== null ? Number(dureeEstimee) : null;
    }
    updateData.updatedAt = new Date().toISOString();

    await firestore.collection('sessions').doc(sessionId).update(updateData);
    return res.status(200).json({ message: 'Session mise à jour.', session: updateData });

  } catch (err) {
    console.error('Erreur update session :', err);
    return res.status(500).json({ message: 'Erreur serveur.' });
  }
});

// ════════════════════════════════
//  SIGNALER UN INCIDENT
//  PATCH /session/:sessionId/incident
// ════════════════════════════════
router.patch('/session/:sessionId/incident', verifierToken, verifierRole('admin'), async (req, res) => {
  const { sessionId } = req.params;
  const { cause, details } = req.body;

  const causesValides = ['panne', 'chauffeur_absent', 'accident', 'autre'];
  if (!cause || !causesValides.includes(cause)) {
    return res.status(400).json({ message: 'Cause invalide.' });
  }
  if (details !== undefined && details !== null && (typeof details !== 'string' || details.length > 500)) {
    return res.status(400).json({ message: 'Détails invalides (max 500 caractères).' });
  }

  try {
    const doc = await firestore.collection('sessions').doc(sessionId).get();
    if (!doc.exists) return res.status(404).json({ message: 'Session introuvable.' });

    const session = doc.data();
    if (req.user.agenceId !== session.agenceId) {
      return res.status(403).json({ message: 'Accès refusé à cette session.' });
    }
    if (!(await essaiEstActif(session.agenceId))) {
      return res.status(403).json({ message: "Période d'essai expirée.", code: 'ESSAI_EXPIRE' });
    }
    if (session.statut === 'annulée') {
      return res.status(409).json({ message: 'Cette session est déjà annulée.' });
    }

    await firestore.collection('sessions').doc(sessionId).update({
      statut:           'annulée',
      causeAnnulation:  cause,
      detailsIncident:  details || null,
      annuleeAt:        new Date().toISOString(),
      updatedAt:        new Date().toISOString(),
    });

    return res.status(200).json({ message: 'Incident signalé.' });

  } catch (err) {
    console.error('Erreur incident session :', err);
    return res.status(500).json({ message: 'Erreur serveur.' });
  }
});

// ════════════════════════════════
//  RÉSERVATIONS ACTIVES D'UNE SESSION
//  GET /session/:sessionId/reservations
// ════════════════════════════════
router.get('/session/:sessionId/reservations', verifierToken, verifierRole('admin'), async (req, res) => {
  const { sessionId } = req.params;

  try {
    const sessionDoc = await firestore.collection('sessions').doc(sessionId).get();
    if (!sessionDoc.exists) return res.status(404).json({ message: 'Session introuvable.' });
    if (req.user.agenceId !== sessionDoc.data().agenceId) {
      return res.status(403).json({ message: 'Accès refusé à cette session.' });
    }

    const agenceDoc = await firestore.collection('agences').doc(sessionDoc.data().agenceId).get();
    const politique = agenceDoc.exists ? agenceDoc.data().politiqueAnnulation : null;

    const resasSnap = await firestore.collection('reservations')
      .where('sessionId', '==', sessionId)
      .where('statut', '!=', 'annulée')
      .get();

    const reservations = resasSnap.docs.map(doc => {
      const r = doc.data();
      const prixTotal = Number(r.prixTotal || 0);
      let montantRembourse = 0;
      if (politique?.remboursement) {
        const fraisPct = politique.precisions || 0;
        montantRembourse = prixTotal - Math.round(prixTotal * fraisPct / 100);
      }
      return {
        id:                r.id,
        prenomPassager:    r.prenomPassager,
        nomPassager:       r.nomPassager       || '',
        telephonePassager: r.telephonePassager || '',
        nbPassagers:       r.nbPassagers       || 1,
        prixTotal,
        montantRembourse,
      };
    });

    return res.status(200).json({ reservations });

  } catch (err) {
    console.error('Erreur récupération réservations session :', err);
    return res.status(500).json({ message: 'Erreur serveur.' });
  }
});

// ════════════════════════════════
//  RÉAFFECTER LES RÉSERVATIONS D'UNE SESSION
//  POST /session/:sessionId/reaffecter
// ════════════════════════════════
router.post('/session/:sessionId/reaffecter', verifierToken, verifierRole('admin'), async (req, res) => {
  const { sessionId } = req.params;
  const { nouveauDepartId } = req.body;
  if (!nouveauDepartId || typeof nouveauDepartId !== 'string') {
    return res.status(400).json({ message: 'nouveauDepartId invalide.' });
  }

  try {
    // ── Lectures préalables non sensibles à la concurrence (config quasi-statique) ──
    const nouveauDepartDoc = await firestore.collection('departs').doc(nouveauDepartId).get();
    if (!nouveauDepartDoc.exists) return res.status(404).json({ message: 'Bus cible introuvable.' });
    const nouveauDepart = nouveauDepartDoc.data();
    if (nouveauDepart.agenceId !== req.user.agenceId) {
      return res.status(403).json({ message: 'Accès refusé à ce bus.' });
    }

    const sessionDocPre = await firestore.collection('sessions').doc(sessionId).get();
    if (!sessionDocPre.exists) return res.status(404).json({ message: 'Session introuvable.' });
    const sessionPre = sessionDocPre.data();
    if (req.user.agenceId !== sessionPre.agenceId) {
      return res.status(403).json({ message: 'Accès refusé à cette session.' });
    }
    if (!(await essaiEstActif(sessionPre.agenceId))) {
      return res.status(403).json({ message: "Période d'essai expirée.", code: 'ESSAI_EXPIRE' });
    }

    if (nouveauDepart.trajetId !== sessionPre.trajetId) {
      return res.status(400).json({ message: 'Le bus cible n\'est pas sur le même trajet.' });
    }

    const trajetDoc = await firestore.collection('trajets').doc(sessionPre.trajetId).get();
    const trajet = trajetDoc.exists ? trajetDoc.data() : null;
    const nbSegments = trajet ? (trajet.arrets || []).length + 1 : 1;

    const nomsArretsCible = (nouveauDepart.arretsActifs || []).map(a => a.nom);
    const dessertToutTrajet = nomsArretsCible.length === 0;

    if (!dessertToutTrajet) {
      const resasCheckSnap = await firestore.collection('reservations')
        .where('sessionId', '==', sessionId)
        .where('statut', '!=', 'annulée')
        .get();

      const arretsManquants = new Set();
      resasCheckSnap.docs.forEach(rDoc => {
        const r = rDoc.data();
        const montee   = r.arretMontee   || trajet?.villeDepart;
        const descente = r.arretDescente || trajet?.villeArrivee;
        if (montee   && montee   !== trajet?.villeDepart  && !nomsArretsCible.includes(montee))   arretsManquants.add(montee);
        if (descente && descente !== trajet?.villeArrivee && !nomsArretsCible.includes(descente)) arretsManquants.add(descente);
      });

      if (arretsManquants.size > 0) {
        return res.status(400).json({
          message: `Le bus cible ne dessert pas : ${[...arretsManquants].join(', ')}. Réaffectation impossible.`,
        });
      }
    }

    // ── Garde-fou : la transaction Firestore ne supporte pas plus de ~500
    // opérations cumulées (lecture + écriture par réservation ≈ 2 ops).
    // Au-delà de ce seuil, on refuse proprement plutôt que de laisser
    // planter la transaction en cours de route.
    const SEUIL_REAFFECTATION = 200;
    const countSnap = await firestore.collection('reservations')
      .where('sessionId', '==', sessionId)
      .where('statut', '!=', 'annulée')
      .count()
      .get();

    if (countSnap.data().count > SEUIL_REAFFECTATION) {
      return res.status(409).json({
        message: `Trop de réservations à réaffecter (${countSnap.data().count}). Contactez le support technique.`,
      });
    }

    // ID généré à l'avance (pas une lecture) pour une éventuelle nouvelle session cible
    const nouvelleCibleRef = firestore.collection('sessions').doc();

    let nbReaffectees = 0;
    let busNomCible = nouveauDepart.busNom;

    try {
      await firestore.runTransaction(async (t) => {
        const sessionRef = firestore.collection('sessions').doc(sessionId);

        // ── Toutes les lectures d'abord ──
        const sessionSnap = await t.get(sessionRef);
        if (!sessionSnap.exists) {
          const err = new Error('Session introuvable.');
          err.code = 404;
          throw err;
        }
        const session = sessionSnap.data();

        const cibleQuery = firestore.collection('sessions')
          .where('departId', '==', nouveauDepartId)
          .where('date', '==', session.date);
        const cibleSnap = await t.get(cibleQuery);

        const resasQuery = firestore.collection('reservations')
          .where('sessionId', '==', sessionId)
          .where('statut', '!=', 'annulée');
        const resasSnap = await t.get(resasQuery);

        // ── Déterminer la session cible ──
        let cibleRef, cible, cibleExiste;
        if (cibleSnap.empty) {
          cibleRef = nouvelleCibleRef;
          cibleExiste = false;
          cible = {
            id: cibleRef.id, departId: nouveauDepartId, trajetId: session.trajetId,
            agenceId: session.agenceId, date: session.date,
            heureDepart: nouveauDepart.heureDepart, busNom: nouveauDepart.busNom,
            arretsActifs: nouveauDepart.arretsActifs || [],
            placesTotal: nouveauDepart.busCapacite, placesVendues: 0,
            placesRestantes: nouveauDepart.busCapacite,
            placesVenduesSegments: Array(nbSegments).fill(0),
            statut: 'ouverte', createdAt: new Date().toISOString(),
          };
        } else {
          cibleRef = cibleSnap.docs[0].ref;
          cible = cibleSnap.docs[0].data();
          cibleExiste = true;
        }

        // ── Simulation de capacité ──
        let placesVenduesCible = cible.placesVenduesSegments && cible.placesVenduesSegments.length === nbSegments
          ? [...cible.placesVenduesSegments]
          : Array(nbSegments).fill(cible.placesVendues || 0);
        let placesVenduesSource = session.placesVenduesSegments && session.placesVenduesSegments.length === nbSegments
          ? [...session.placesVenduesSegments]
          : Array(nbSegments).fill(session.placesVendues || 0);

        const placesSimulees = [...placesVenduesCible];
        for (const rDoc of resasSnap.docs) {
          const r = rDoc.data();
          const segInfo = trajet ? getSegmentsTrajet(trajet, r.arretMontee, r.arretDescente) : null;
          if (segInfo) {
            for (const idx of segInfo.segments) {
              if ((placesSimulees[idx] || 0) + (r.nbPassagers || 1) > cible.placesTotal) {
                const err = new Error(`Pas assez de places sur le bus cible pour tout réaffecter (session du ${session.date}).`);
                err.code = 409;
                throw err;
              }
            }
            segInfo.segments.forEach(idx => {
              placesSimulees[idx] = (placesSimulees[idx] || 0) + (r.nbPassagers || 1);
            });
          }
        }

        // ── Écritures (toutes après les lectures) ──
        const now = new Date().toISOString();

        if (!cibleExiste) {
          t.set(cibleRef, cible);
        }

        resasSnap.docs.forEach(rDoc => {
          const r = rDoc.data();
          const segInfo = trajet ? getSegmentsTrajet(trajet, r.arretMontee, r.arretDescente) : null;
          if (segInfo) {
            segInfo.segments.forEach(idx => {
              placesVenduesCible[idx]  = (placesVenduesCible[idx] || 0) + (r.nbPassagers || 1);
              placesVenduesSource[idx] = Math.max(0, (placesVenduesSource[idx] || 0) - (r.nbPassagers || 1));
            });
          }
          t.update(rDoc.ref, {
            sessionId: cibleRef.id,
            busNom: nouveauDepart.busNom,
            reaffectee: true,
            ancienBusNom: session.busNom,
            nouveauBusNom: nouveauDepart.busNom,
            ancienDepartId: session.departId,
            nouveauDepartId,
            dateReaffectation: now,
            updatedAt: now,
          });
        });

        t.update(cibleRef, {
          placesVenduesSegments: placesVenduesCible,
          placesVendues: placesVenduesCible.reduce((a,b) => Math.max(a,b), 0),
          placesRestantes: cible.placesTotal - Math.max(0, ...placesVenduesCible),
          updatedAt: now,
        });
        t.update(sessionRef, {
          placesVenduesSegments: placesVenduesSource,
          placesVendues: 0,
          placesRestantes: session.placesTotal,
          updatedAt: now,
        });

        nbReaffectees = resasSnap.size;
        busNomCible = nouveauDepart.busNom;
      });
    } catch (txErr) {
      if (txErr.code === 404) return res.status(404).json({ message: txErr.message });
      if (txErr.code === 409) return res.status(409).json({ message: txErr.message });
      throw txErr;
    }

    return res.status(200).json({
      message: `${nbReaffectees} réservation(s) réaffectée(s) vers ${busNomCible}.`,
      nbReaffectees,
    });

  } catch (err) {
    console.error('Erreur réaffectation session :', err);
    return res.status(500).json({ message: 'Erreur serveur.' });
  }
});

// ════════════════════════════════
//  ANNULER TOUTES LES RÉSERVATIONS D'UNE SESSION
//  POST /session/:sessionId/annuler-toutes
// ════════════════════════════════
router.post('/session/:sessionId/annuler-toutes', verifierToken, verifierRole('admin'), async (req, res) => {
  const { sessionId } = req.params;
  try {
    const sessionDoc = await firestore.collection('sessions').doc(sessionId).get();
    if (!sessionDoc.exists) return res.status(404).json({ message: 'Session introuvable.' });
    const session = sessionDoc.data();
    if (req.user.agenceId !== session.agenceId) {
      return res.status(403).json({ message: 'Accès refusé à cette session.' });
    }
    if (!(await essaiEstActif(session.agenceId))) {
      return res.status(403).json({ message: "Période d'essai expirée.", code: 'ESSAI_EXPIRE' });
    }

    const agenceDoc  = await firestore.collection('agences').doc(session.agenceId).get();
    const politique  = agenceDoc.exists ? agenceDoc.data().politiqueAnnulation : null;

    const resasSnap = await firestore.collection('reservations')
      .where('sessionId', '==', sessionId)
      .where('statut', '!=', 'annulée')
      .get();

    const batch = creerBatchAutoCommit(firestore);
    const now = new Date().toISOString();
    let totalRembourse = 0;
    const pdvIncrements = {};

    for (const rDoc of resasSnap.docs) {
      const r = rDoc.data();
      const prixTotal = Number(r.prixTotal || 0);
      let frais = prixTotal, rembourse = 0;
      if (politique?.remboursement) {
        const fraisPct = politique.precisions || 0;
        frais = Math.round(prixTotal * fraisPct / 100);
        rembourse = prixTotal - frais;
      }
      totalRembourse += rembourse;
      await batch.update(rDoc.ref, {
        statut: 'annulée', annuleeAt: now,
        fraisRetenus: frais, montantRembourse: rembourse,
      });
      if (r.pdvId) pdvIncrements[r.pdvId] = (pdvIncrements[r.pdvId] || 0) + (r.nbPassagers || 1);
    }

    for (const [pdvId, nb] of Object.entries(pdvIncrements)) {
      await batch.update(firestore.collection('pointsDeVente').doc(pdvId), {
        annulations: FieldValue.increment(nb),
        updatedAt:   now,
      });
    }

    await batch.commitFinal();

    return res.status(200).json({ message: `${resasSnap.size} réservation(s) annulée(s).`, nbAnnulees: resasSnap.size, totalRembourse });

  } catch (err) {
    console.error('Erreur annulation session :', err);
    return res.status(500).json({ message: 'Erreur serveur.' });
  }
});

module.exports = router;