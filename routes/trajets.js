const express = require('express');
const router  = express.Router();
const { essaiEstActif } = require('../helpers/essai');

const { firestore } = require('../firebase');
const { todayBrazza } = require('../helpers/dates');
const { checkEssai } = require('../helpers/essai');
const { verifierImpactReservationsTrajet } = require('../helpers/reservations-impact');

// ── Helper : batch auto-découpé pour rester sous la limite de 500 ops ──
function creerBatchAutoCommit(firestore, limite = 450) {
  let batch = firestore.batch();
  let count = 0;
  const commits = [];

  async function flushSiNecessaire() {
    if (count >= limite) {
      commits.push(batch.commit());
      batch = firestore.batch();
      count = 0;
    }
  }

  return {
    async set(ref, data) { batch.set(ref, data); count++; await flushSiNecessaire(); },
    async update(ref, data) { batch.update(ref, data); count++; await flushSiNecessaire(); },
    async delete(ref) { batch.delete(ref); count++; await flushSiNecessaire(); },
    async commitFinal() {
      if (count > 0) commits.push(batch.commit());
      await Promise.all(commits);
    },
  };
}

// ════════════════════════════════
//  CRÉER UN TRAJET
//  POST /trajet/create
// ════════════════════════════════
router.post('/create', checkEssai, async (req, res) => {
  const {
    agenceId, villeDepart, villeArrivee, typeTrajet,
    arrets, pdvDepart, pdvArrivee, pdvArrets, prixAdulte,
    prixEnfant, limiteBagages, fraisExcesBagages,
  } = req.body;

  const { prixParType } = req.body;
  if (!agenceId || !villeDepart || !villeArrivee || !typeTrajet ||
    !prixParType || Object.keys(prixParType).length === 0) {
    return res.status(400).json({ message: 'Champs obligatoires manquants.' });
  }

  try {
    const ref  = firestore.collection('trajets').doc();
    const id   = ref.id;

    const trajetData = {
      id, agenceId, villeDepart, villeArrivee, typeTrajet,
      arrets: arrets || [], pdvDepart: pdvDepart || [],
      prixTroncons: req.body.prixTroncons || {},
      pdvArrivee:   pdvArrivee  || [], pdvArrets: pdvArrets || [],
      prixParType,
      limiteBagages:     limiteBagages     || null,
      fraisExcesBagages: fraisExcesBagages || null,
      actif:             true,
      createdAt:    new Date().toISOString(),
    };

    await ref.set(trajetData);

    return res.status(201).json({
      message: 'Trajet créé avec succès.',
      trajet:  trajetData,
    });

  } catch (err) {
    console.error('Erreur création trajet :', err);
    return res.status(500).json({ message: 'Erreur serveur, réessayez.' });
  }
});

// ════════════════════════════════
//  RÉCUPÉRER LES TRAJETS
//  GET /trajets?agenceId=xxx
//  (monté séparément à la racine — voir server.js)
// ════════════════════════════════
router.get('/all', async (req, res) => {
  const { agenceId } = req.query;

  if (!agenceId) {
    return res.status(400).json({ message: 'agenceId manquant.' });
  }

  try {
    const snapshot = await firestore
      .collection('trajets')
      .where('agenceId', '==', agenceId)
      .orderBy('createdAt', 'desc')
      .get();

    const trajets = snapshot.docs.map(doc => doc.data());

    return res.status(200).json({ trajets });

  } catch (err) {
    console.error('Erreur récupération trajets :', err);
    return res.status(500).json({ message: 'Erreur serveur, réessayez.' });
  }
});

// ════════════════════════════════
//  SUPPRIMER UN TRAJET
//  DELETE /trajet/:trajetId
// ════════════════════════════════
router.delete('/:trajetId', async (req, res) => {
  const { trajetId } = req.params;

  try {
    const trajetDoc = await firestore.collection('trajets').doc(trajetId).get();
    if (!trajetDoc.exists) return res.status(404).json({ message: 'Trajet introuvable.' });

    const trajet  = trajetDoc.data();
    const today   = todayBrazza();

    if (!(await essaiEstActif(trajet.agenceId))) {
      return res.status(403).json({ message: "Période d'essai expirée.", code: 'ESSAI_EXPIRE' });
    }

    const blocage = await verifierImpactReservationsTrajet(trajetId, today);
    if (blocage.sessions.length > 0) {
      return res.status(409).json({
        code: 'RESA_BLOQUANTES',
        message: `Ce trajet a ${blocage.totalReservations} réservation(s) future(s) sur ${blocage.sessions.length} session(s). Annulez-les avant de continuer.`,
        sessions: blocage.sessions,
      });
    }

    const now     = new Date().toISOString();
    const expires = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();

    const departsSnap = await firestore.collection('departs')
      .where('trajetId', '==', trajetId)
      .get();

    const batch = creerBatchAutoCommit(firestore);

    for (const departDoc of departsSnap.docs) {
      const depart = departDoc.data();

      const sessionsSnap = await firestore.collection('sessions')
        .where('departId', '==', depart.id)
        .get();

      for (const sDoc of sessionsSnap.docs) {
        const s = sDoc.data();
        if (s.date >= today && s.statut !== 'annulée') {
          await batch.update(sDoc.ref, {
            trajetSupprime: true,
            trajetNom:      `${trajet.villeDepart} → ${trajet.villeArrivee}`,
            busNom:         depart.busNom,
            archivedAt:     now,
            expiresAt:      expires,
            statut:         'archivée',
          });
        } else {
          await batch.update(sDoc.ref, {
            trajetSupprime: true,
            trajetNom:      `${trajet.villeDepart} → ${trajet.villeArrivee}`,
            archivedAt:     now,
            expiresAt:      expires,
          });
        }
      }

      const histDepartRef = firestore.collection('historique').doc();
      await batch.set(histDepartRef, {
        ...depart,
        type:           'depart',
        trajetNom:      `${trajet.villeDepart} → ${trajet.villeArrivee}`,
        suppressionAt:  now,
        expiresAt:      expires,
      });

      await batch.delete(departDoc.ref);
    }

    const histTrajetRef = firestore.collection('historique').doc();
    await batch.set(histTrajetRef, {
      ...trajet,
      type:          'trajet',
      suppressionAt: now,
      expiresAt:     expires,
    });

    await batch.delete(trajetDoc.ref);

    await batch.commitFinal();

    return res.status(200).json({
      message: `Trajet archivé. Départs et sessions conservés dans l'historique pendant 1 an.`,
    });

  } catch (err) {
    console.error('Erreur suppression trajet :', err);
    return res.status(500).json({ message: 'Erreur serveur.' });
  }
});

// ════════════════════════════════
//  MODIFIER UN TRAJET
//  PATCH /trajet/:trajetId
// ════════════════════════════════
router.patch('/:trajetId', async (req, res) => {
  const { trajetId } = req.params;
  const {
    prixParType,
    limiteBagages, fraisExcesBagages,
    arrets,
  } = req.body;

  if (!prixParType || Object.keys(prixParType).length === 0) {
    return res.status(400).json({ message: 'Champs obligatoires manquants.' });
  }

  try {
    const trajetDocCheck = await firestore.collection('trajets').doc(trajetId).get();
    if (!trajetDocCheck.exists) return res.status(404).json({ message: 'Trajet introuvable.' });
    if (!(await essaiEstActif(trajetDocCheck.data().agenceId))) {
      return res.status(403).json({ message: "Période d'essai expirée.", code: 'ESSAI_EXPIRE' });
    }

    const pdvArretsRecalc = arrets !== undefined
      ? arrets.filter(a => a.type === 'pdv').map(a => ({ id: a.id, nom: a.nom, ville: a.ville || '' }))
      : undefined;

    const updateData = {
      prixParType,
      limiteBagages:     limiteBagages     || null,
      fraisExcesBagages: fraisExcesBagages || null,
      ...(arrets !== undefined && { arrets }),
      ...(pdvArretsRecalc !== undefined && { pdvArrets: pdvArretsRecalc }),
      ...(req.body.prixTroncons !== undefined && { prixTroncons: req.body.prixTroncons }),
      updatedAt:         new Date().toISOString(),
    };

    await firestore.collection('trajets').doc(trajetId).update(updateData);

    if (arrets !== undefined) {
      const today = todayBrazza()

      const sessionsSnap = await firestore
        .collection('sessions')
        .where('trajetId', '==', trajetId)
        .where('date', '>=', today)
        .get();

      const nbNouveauxSegments = arrets.length + 1;

      const batch = creerBatchAutoCommit(firestore);

      for (const doc of sessionsSnap.docs) {
        const session = doc.data();
        const nomsNouveaux = arrets.map(a => a.nom);
        const arretsActifsFiltres = (session.arretsActifs || [])
          .filter(a => nomsNouveaux.includes(a.nom));

        const ancientableau = session.placesVenduesSegments || [];
        const nouveauTableau = Array(nbNouveauxSegments).fill(0).map((_, i) => {
          return ancientableau[i] ?? 0;
        });

        await batch.update(doc.ref, {
          arretsActifs: arretsActifsFiltres,
          placesVenduesSegments: nouveauTableau,
          placesRestantes: session.placesTotal - Math.max(0, ...nouveauTableau),
          updatedAt: new Date().toISOString(),
        });
      }

      await batch.commitFinal();
    }

    return res.status(200).json({ message: 'Trajet mis à jour.', trajet: updateData });

  } catch (err) {
    console.error('Erreur update trajet :', err);
    return res.status(500).json({ message: 'Erreur serveur, réessayez.' });
  }
});

// ════════════════════════════════
//  STATS D'UN TRAJET
//  GET /trajet/:trajetId/stats?dateDebut=&dateFin=
// ════════════════════════════════
router.get('/:trajetId/stats', async (req, res) => {
  const { trajetId } = req.params;
  const { dateDebut, dateFin } = req.query;

  const OFFSET_MS = 1 * 60 * 60 * 1000;
  const defautFin   = new Date(Date.now() + OFFSET_MS).toISOString().split('T')[0];
  const defautDebut = new Date(Date.now() + OFFSET_MS - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const debut = dateDebut || defautDebut;
  const fin   = dateFin   || defautFin;

  try {
    const departsSnap = await firestore.collection('departs').where('trajetId', '==', trajetId).get();
    const departs = departsSnap.docs.map(d => d.data());

    const sessionsSnap = await firestore.collection('sessions')
      .where('trajetId', '==', trajetId)
      .where('date', '>=', debut)
      .where('date', '<=', fin)
      .get();
    const sessions = sessionsSnap.docs.map(d => d.data()).filter(s => s.statut !== 'annulée');

    const bus = departs.map(d => {
      const sessionsBus = sessions.filter(s => s.departId === d.id);
      const vendus   = sessionsBus.reduce((acc, s) => acc + (s.placesVendues || 0), 0);
      const capacite = sessionsBus.reduce((acc, s) => acc + (s.placesTotal   || 0), 0);
      const taux     = capacite > 0 ? Math.round((vendus / capacite) * 100) : 0;
      return {
        id: d.id, nom: d.busNom, heureDepart: d.heureDepart,
        actif: d.actif !== false,
        vendus, capaciteTotale: capacite, taux,
        nbSessions: sessionsBus.length,
      };
    });

    return res.status(200).json({ bus });
  } catch (err) {
    console.error('Erreur stats trajet :', err);
    return res.status(500).json({ message: 'Erreur serveur.' });
  }
});

// ════════════════════════════════
//  ACTIVER / DÉSACTIVER UN TRAJET
//  PATCH /trajet/:trajetId/statut
// ════════════════════════════════
router.patch('/:trajetId/statut', async (req, res) => {
  const { trajetId } = req.params;
  const { actif } = req.body;

  if (typeof actif !== 'boolean') {
    return res.status(400).json({ message: 'Le champ actif doit être true ou false.' });
  }

  try {
    const trajetDocCheck = await firestore.collection('trajets').doc(trajetId).get();
    if (!trajetDocCheck.exists) return res.status(404).json({ message: 'Trajet introuvable.' });
    if (!(await essaiEstActif(trajetDocCheck.data().agenceId))) {
      return res.status(403).json({ message: "Période d'essai expirée.", code: 'ESSAI_EXPIRE' });
    }

    const today = todayBrazza();

    if (actif === false) {
      const blocage = await verifierImpactReservationsTrajet(trajetId, today);
      if (blocage.sessions.length > 0) {
        return res.status(409).json({
          code: 'RESA_BLOQUANTES',
          message: `Ce trajet a ${blocage.totalReservations} réservation(s) future(s) sur ${blocage.sessions.length} session(s), réparties sur plusieurs bus. Annulez-les avant de continuer.`,
          sessions: blocage.sessions,
        });
      }
    }

    await firestore.collection('trajets').doc(trajetId).update({
      actif,
      updatedAt: new Date().toISOString(),
    });

    let sessionsSupprimees = 0;
    let busDesactives = 0;

    if (actif === false) {
      const departsSnap = await firestore.collection('departs')
        .where('trajetId', '==', trajetId)
        .get();

      const batch = creerBatchAutoCommit(firestore);

      for (const departDoc of departsSnap.docs) {
        const depart = departDoc.data();

        await batch.update(departDoc.ref, {
          actif: false,
          updatedAt: new Date().toISOString(),
        });
        busDesactives++;

        const sessionsSnap = await firestore.collection('sessions')
          .where('departId', '==', depart.id)
          .where('date', '>=', today)
          .get();

        for (const sDoc of sessionsSnap.docs) {
          if (sDoc.data().statut !== 'annulée') {
            await batch.delete(sDoc.ref);
            sessionsSupprimees++;
          }
        }
      }

      await batch.commitFinal();
    }

    if (actif === true) {
      const departsSnap = await firestore.collection('departs')
        .where('trajetId', '==', trajetId)
        .get();

      const batch = creerBatchAutoCommit(firestore);
      for (const doc of departsSnap.docs) {
        await batch.update(doc.ref, {
          actif: true,
          updatedAt: new Date().toISOString(),
        });
        busDesactives++;
      }
      await batch.commitFinal();
    }

    return res.status(200).json({
      message: actif
        ? `Trajet activé. ${busDesactives} bus réactivé(s). Pensez à régénérer les sessions.`
        : `Trajet désactivé. ${busDesactives} bus désactivé(s), ${sessionsSupprimees} session(s) future(s) supprimée(s).`,
      sessionsSupprimees,
      busDesactives,
    });

  } catch (err) {
    console.error('Erreur statut trajet :', err);
    return res.status(500).json({ message: 'Erreur serveur, réessayez.' });
  }
});

module.exports = router;