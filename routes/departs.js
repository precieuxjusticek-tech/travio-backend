const express = require('express');
const router  = express.Router();
const { essaiEstActif } = require('../helpers/essai');

const { firestore } = require('../firebase');
const { todayBrazza } = require('../helpers/dates');
const { checkEssai } = require('../helpers/essai');
const { verifierImpactReservations } = require('../helpers/reservations-impact');
const { verifierToken } = require('../middlewares/verifierToken');

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
//  CRÉER UN DÉPART
//  POST /trajet/:trajetId/depart/create
// ════════════════════════════════
router.post('/trajet/:trajetId/depart/create', verifierToken, checkEssai, async (req, res) => {
  const { trajetId } = req.params;
  const {
    agenceId, busNom, busType, busCapacite, heureDepart,
    heureArrivee, dureeEstimee, tousLesJours, jours, arretsActifs, vehiculeId
  } = req.body;

  if (req.user.agenceId !== agenceId) {
    return res.status(403).json({ message: 'Accès refusé à cette agence.' });
  }

  if (!busNom || !busType || !busCapacite || !heureDepart) {
    return res.status(400).json({ message: 'Champs obligatoires manquants.' });
  }

  try {
    if (vehiculeId) {
      const doublonSnap = await firestore.collection('departs')
        .where('trajetId', '==', trajetId)
        .where('vehiculeId', '==', vehiculeId)
        .get();
      if (!doublonSnap.empty) {
        return res.status(409).json({
          message: 'Ce véhicule est déjà assigné à un bus sur ce trajet. Un véhicule ne peut apparaître qu\'une seule fois par trajet.',
        });
      }
    }

    const ref = firestore.collection('departs').doc();
    const departData = {
      id: ref.id, trajetId, agenceId,
      busNom, busType, busCapacite,
      vehiculeId: vehiculeId || null,
      heureDepart, heureArrivee: heureArrivee || null,
      dureeEstimee: dureeEstimee || null,
      tousLesJours: tousLesJours ?? true,
      jours: jours || [],
      arretsActifs: arretsActifs || [],
      placesTotal: busCapacite,
      placesVendues: 0,
      actif: true,
      createdAt: new Date().toISOString(),
    };
    await ref.set(departData);
    return res.status(201).json({ message: 'Départ créé.', depart: departData });
  } catch (err) {
    return res.status(500).json({ message: 'Erreur serveur.' });
  }
});

// ════════════════════════════════
//  RÉCUPÉRER LES DÉPARTS D'UN TRAJET
//  GET /trajet/:trajetId/departs
// ════════════════════════════════
router.get('/trajet/:trajetId/departs', verifierToken, async (req, res) => {
  const { trajetId } = req.params;
  try {
    const trajetDoc = await firestore.collection('trajets').doc(trajetId).get();
    if (!trajetDoc.exists) return res.status(404).json({ message: 'Trajet introuvable.' });

    if (req.user.agenceId !== trajetDoc.data().agenceId) {
      return res.status(403).json({ message: 'Accès refusé à ce trajet.' });
    }

    const snapshot = await firestore.collection('departs').where('trajetId', '==', trajetId).orderBy('heureDepart', 'asc').get();
    return res.status(200).json({ departs: snapshot.docs.map(d => d.data()) });
  } catch (err) {
    return res.status(500).json({ message: 'Erreur serveur.' });
  }
});

// ════════════════════════════════
//  RÉCUPÉRER TOUS LES BUS D'UNE AGENCE
//  GET /departs?agenceId=xxx
// ════════════════════════════════
router.get('/departs', verifierToken, async (req, res) => {
  const { agenceId } = req.query;

  if (req.user.agenceId !== agenceId) {
    return res.status(403).json({ message: 'Accès refusé à cette agence.' });
  }

  if (!agenceId) return res.status(400).json({ message: 'agenceId manquant.' });
  try {
    const snapshot = await firestore.collection('departs').where('agenceId', '==', agenceId).get();
    return res.status(200).json({ departs: snapshot.docs.map(d => d.data()) });
  } catch (err) {
    console.error('Erreur récupération departs agence :', err);
    return res.status(500).json({ message: 'Erreur serveur.' });
  }
});

// ════════════════════════════════
//  MODIFIER UN DÉPART
//  PATCH /depart/:departId
// ════════════════════════════════
router.patch('/depart/:departId', verifierToken, async (req, res) => {
  const { departId } = req.params;
  const { busNom, busType, busCapacite, heureDepart, heureArrivee, dureeEstimee, tousLesJours, jours, arretsActifs } = req.body;

  try {
    const departDoc = await firestore.collection('departs').doc(departId).get();
    if (!departDoc.exists) return res.status(404).json({ message: 'Départ introuvable.' });
    const ancienDepart = departDoc.data();

    if (req.user.agenceId !== ancienDepart.agenceId) {
      return res.status(403).json({ message: 'Accès refusé à ce départ.' });
    }

    if (!busNom || !busType || !busCapacite || !heureDepart) {
      return res.status(400).json({ message: 'Champs obligatoires manquants.' });
    }

    if (!(await essaiEstActif(ancienDepart.agenceId))) {
      return res.status(403).json({ message: "Période d'essai expirée.", code: 'ESSAI_EXPIRE' });
    }

    const joursChanges = JSON.stringify(ancienDepart.jours) !== JSON.stringify(jours) ||
                         ancienDepart.tousLesJours !== tousLesJours;

    const updateData = {
      busNom, busType,
      busCapacite:  parseInt(busCapacite),
      heureDepart,
      heureArrivee: heureArrivee  || null,
      dureeEstimee: dureeEstimee  || null,
      tousLesJours: tousLesJours  ?? true,
      jours:        jours         || [],
      updatedAt:    new Date().toISOString(),
    };
    if (arretsActifs !== undefined) updateData.arretsActifs = arretsActifs;

    await firestore.collection('departs').doc(departId).update(updateData);

    const today = todayBrazza();
    const sessionsSnap = await firestore.collection('sessions')
      .where('departId', '==', departId)
      .where('date', '>=', today)
      .get();

    if (!sessionsSnap.empty) {
      const batch = creerBatchAutoCommit(firestore);
      for (const doc of sessionsSnap.docs) {
        const s = doc.data();
        if (s.statut === 'annulée') continue;
        const sessionUpdate = {
          busNom,
          busType,
          placesTotal:     parseInt(busCapacite),
          placesRestantes: Math.max(0, parseInt(busCapacite) - (s.placesVendues || 0)),
          heureDepart,
          heureArrivee:    heureArrivee || null,
          dureeEstimee:    dureeEstimee || null,
          updatedAt:       new Date().toISOString(),
        };
        if (arretsActifs !== undefined) sessionUpdate.arretsActifs = arretsActifs;
        await batch.update(doc.ref, sessionUpdate);
      }
      await batch.commitFinal();
    }

    return res.status(200).json({
      message:     'Bus mis à jour.',
      depart:      updateData,
      joursChanges,
    });

  } catch (err) {
    console.error('Erreur update départ :', err);
    return res.status(500).json({ message: 'Erreur serveur.' });
  }
});

// ════════════════════════════════
//  STATUT D'UN DÉPART
//  PATCH /depart/:departId/statut
// ════════════════════════════════
router.patch('/depart/:departId/statut', verifierToken, async (req, res) => {
  const { departId } = req.params;
  const { actif } = req.body;

  try {
    const departDoc = await firestore.collection('departs').doc(departId).get();
    if (!departDoc.exists) return res.status(404).json({ message: 'Départ introuvable.' });
    const depart = departDoc.data();

    if (req.user.agenceId !== depart.agenceId) {
      return res.status(403).json({ message: 'Accès refusé à ce départ.' });
    }

    if (typeof actif !== 'boolean') return res.status(400).json({ message: 'actif doit être boolean.' });

    const today  = todayBrazza();
    if (!(await essaiEstActif(depart.agenceId))) {
      return res.status(403).json({ message: "Période d'essai expirée.", code: 'ESSAI_EXPIRE' });
    }

    if (actif === false) {
      const blocage = await verifierImpactReservations(departId, depart.trajetId, today);
      if (blocage.sessions.length > 0) {
        return res.status(409).json({
          code: 'RESA_BLOQUANTES',
          message: `Ce bus a ${blocage.totalReservations} réservation(s) future(s) sur ${blocage.sessions.length} session(s). Choisissez une action avant de continuer.`,
          sessions: blocage.sessions,
        });
      }
    }

    await firestore.collection('departs').doc(departId).update({ actif, updatedAt: new Date().toISOString() });

    let sessionsSupprimees = 0;
    if (actif === false) {
      const sessionsSnap = await firestore.collection('sessions')
        .where('departId', '==', departId)
        .where('date', '>=', today)
        .get();

      const batch = creerBatchAutoCommit(firestore);
      for (const sDoc of sessionsSnap.docs) {
        const s = sDoc.data();
        if (s.statut !== 'annulée') { await batch.delete(sDoc.ref); sessionsSupprimees++; }
      }
      if (sessionsSupprimees > 0) await batch.commitFinal();
    }

    return res.status(200).json({
      message: actif
        ? 'Départ activé.'
        : `Départ désactivé. ${sessionsSupprimees} session(s) future(s) supprimée(s).`,
      sessionsSupprimees,
    });

  } catch (err) {
    console.error('Erreur statut départ :', err);
    return res.status(500).json({ message: 'Erreur serveur.' });
  }
});

// ════════════════════════════════
//  GÉNÉRER LES SESSIONS AUTOMATIQUEMENT
//  POST /depart/:departId/generer-sessions
// ════════════════════════════════
router.post('/depart/:departId/generer-sessions', verifierToken, async (req, res) => {
  const { departId } = req.params;
  const { nbJours = 14 } = req.body;

  try {
    const departDoc = await firestore.collection('departs').doc(departId).get();
    if (!departDoc.exists) return res.status(404).json({ message: 'Départ introuvable.' });
    const depart = departDoc.data();

    if (req.user.agenceId && req.user.agenceId !== depart.agenceId) {
      return res.status(403).json({ message: 'Accès refusé à ce départ.' });
    }

    if (!(await essaiEstActif(depart.agenceId))) {
      return res.status(403).json({ message: "Période d'essai expirée.", code: 'ESSAI_EXPIRE' });
    }

    const joursMap = { 'Dim': 0, 'Lun': 1, 'Mar': 2, 'Mer': 3, 'Jeu': 4, 'Ven': 5, 'Sam': 6 };

    let joursActifs;
    if (depart.tousLesJours) {
      joursActifs = [0, 1, 2, 3, 4, 5, 6];
    } else {
      joursActifs = (depart.jours || [])
        .map(j => joursMap[j])
        .filter(n => n !== undefined);
    }

    if (!depart.tousLesJours && joursActifs.length === 0) {
      return res.status(400).json({ message: 'Aucun jour valide configuré pour ce départ.' });
    }

    const OFFSET_MS = 1 * 60 * 60 * 1000;

    const nowUTC      = Date.now();
    const nowLocal    = new Date(nowUTC + OFFSET_MS);
    const todayStr    = nowLocal.toISOString().split('T')[0];

    const trajetDoc = await firestore.collection('trajets').doc(depart.trajetId).get();
    const trajet = trajetDoc.exists ? trajetDoc.data() : null;
    const nbSegments = trajet ? (trajet.arrets || []).length + 1 : 1;

    const sessionsCreees = [];

    for (let i = 0; i < nbJours; i++) {
      const targetMs    = nowUTC + OFFSET_MS + i * 24 * 60 * 60 * 1000;
      const targetLocal = new Date(targetMs);
      const dateStr     = targetLocal.toISOString().split('T')[0];

      const [yyyy, mm, dd] = dateStr.split('-').map(Number);
      const dateForDay  = new Date(Date.UTC(yyyy, mm - 1, dd));
      const jourIndex   = dateForDay.getUTCDay();

      if (!joursActifs.includes(jourIndex)) continue;

      const departInstantUTC = new Date(`${dateStr}T${depart.heureDepart}:00Z`).getTime() - OFFSET_MS;
      if (departInstantUTC < nowUTC) continue;

      const existing = await firestore.collection('sessions')
        .where('departId', '==', departId)
        .where('date', '==', dateStr)
        .get();
      if (!existing.empty) continue;

      const ref = firestore.collection('sessions').doc();
      await ref.set({
        id:              ref.id,
        departId,
        trajetId:        depart.trajetId,
        agenceId:        depart.agenceId,
        date:            dateStr,
        heureDepart:     depart.heureDepart,
        busNom:          depart.busNom,
        arretsActifs:    depart.arretsActifs || [],
        placesTotal:     depart.busCapacite,
        placesVendues:   0,
        placesRestantes: depart.busCapacite,
        placesVenduesSegments: Array(nbSegments).fill(0),
        statut:          'ouverte',
        createdAt:       new Date().toISOString(),
      });

      sessionsCreees.push(dateStr);
    }

    return res.status(201).json({
      message:  `${sessionsCreees.length} session(s) générée(s).`,
      sessions: sessionsCreees,
    });

  } catch (err) {
    console.error('Erreur génération sessions :', err);
    return res.status(500).json({ message: 'Erreur serveur.' });
  }
});

// ════════════════════════════════
//  SUPPRIMER UN DÉPART
//  DELETE /depart/:departId
// ════════════════════════════════
router.delete('/depart/:departId', verifierToken, async (req, res) => {
  const { departId } = req.params;

  try {
    const doc = await firestore.collection('departs').doc(departId).get();
    if (!doc.exists) return res.status(404).json({ message: 'Départ introuvable.' });
    const depart = doc.data();

    if (req.user.agenceId !== depart.agenceId) {
      return res.status(403).json({ message: 'Accès refusé à ce départ.' });
    }

    const today  = todayBrazza();
    if (!(await essaiEstActif(depart.agenceId))) {
      return res.status(403).json({ message: "Période d'essai expirée.", code: 'ESSAI_EXPIRE' });
    }

    const blocage = await verifierImpactReservations(departId, depart.trajetId, today);
    if (blocage.sessions.length > 0) {
      return res.status(409).json({
        code: 'RESA_BLOQUANTES',
        message: `Ce bus a ${blocage.totalReservations} réservation(s) future(s) sur ${blocage.sessions.length} session(s). Choisissez une action avant de continuer.`,
        sessions: blocage.sessions,
      });
    }

    const sessionsSnap = await firestore.collection('sessions')
      .where('departId', '==', departId)
      .get();

    const batch = creerBatchAutoCommit(firestore);
    let futuresSupprimees = 0;
    let passeesMarcquees  = 0;

    for (const sDoc of sessionsSnap.docs) {
      const s = sDoc.data();
      if (s.date >= today && s.statut !== 'annulée') {
        await batch.delete(sDoc.ref);
        futuresSupprimees++;
      } else {
        await batch.update(sDoc.ref, {
          departSupprime: true,
          departNom:      depart.busNom,
          archivedAt:     new Date().toISOString(),
          expiresAt:      new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
        });
        passeesMarcquees++;
      }
    }

    await batch.commitFinal();

    await firestore.collection('departs').doc(departId).delete();

    return res.status(200).json({
      message: `Bus supprimé. ${futuresSupprimees} session(s) future(s) supprimée(s), ${passeesMarcquees} session(s) passée(s) conservée(s) dans l'historique.`,
      futuresSupprimees,
      passeesMarcquees,
    });

  } catch (err) {
    console.error('Erreur suppression départ :', err);
    return res.status(500).json({ message: 'Erreur serveur.' });
  }
});

// ════════════════════════════════
//  RÉCUPÉRER UN DÉPART PAR ID
//  GET /depart/:departId
// ════════════════════════════════
router.get('/depart/:departId', verifierToken, async (req, res) => {
  const { departId } = req.params;
  try {
    const doc = await firestore.collection('departs').doc(departId).get();
    if (!doc.exists) return res.status(404).json({ message: 'Départ introuvable.' });

    if (req.user.agenceId !== doc.data().agenceId) {
      return res.status(403).json({ message: 'Accès refusé à ce départ.' });
    }

    return res.status(200).json(doc.data());
  } catch (err) {
    return res.status(500).json({ message: 'Erreur serveur.' });
  }
});

module.exports = router;