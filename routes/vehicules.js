const express = require('express');
const router  = express.Router();
const { essaiEstActif } = require('../helpers/essai');

const { firestore } = require('../firebase');
const { todayBrazza } = require('../helpers/dates');
const { checkEssai } = require('../helpers/essai');
const { verifierImpactReservationsVehicule } = require('../helpers/reservations-impact');
const { verifierToken } = require('../middlewares/verifierToken');
const { verifierRole } = require('../middlewares/verifierRole');
const { creerBatchAutoCommit } = require('../helpers/batch');

// ════════════════════════════════
//  CRÉER UN VÉHICULE
//  POST /vehicule/create
// ════════════════════════════════
router.post('/create', verifierToken, verifierRole('admin'), checkEssai, async (req, res) => {
  const { nom, type, capacite, chauffeurNom, chauffeurTel } = req.body;
  const agenceId = req.user.agenceId;
  if (!agenceId || !nom || !type || !capacite) {
    return res.status(400).json({ message: 'Champs obligatoires manquants.' });
  }
  if (typeof nom !== 'string' || nom.trim().length < 1 || nom.length > 100) {
    return res.status(400).json({ message: 'Nom du véhicule invalide.' });
  }
  if (typeof type !== 'string' || type.length > 50) {
    return res.status(400).json({ message: 'Type de véhicule invalide.' });
  }
  const capaciteNum = Number(capacite);
  if (!Number.isInteger(capaciteNum) || capaciteNum <= 0 || capaciteNum > 200) {
    return res.status(400).json({ message: 'Capacité invalide.' });
  }
  if (chauffeurNom !== undefined && chauffeurNom !== null && (typeof chauffeurNom !== 'string' || chauffeurNom.length > 100)) {
    return res.status(400).json({ message: 'Nom du chauffeur invalide.' });
  }
  if (chauffeurTel !== undefined && chauffeurTel !== null && chauffeurTel !== '' && (typeof chauffeurTel !== 'string' || !/^\+?[0-9]{6,15}$/.test(chauffeurTel.replace(/\s/g, '')))) {
    return res.status(400).json({ message: 'Téléphone du chauffeur invalide.' });
  }
  try {
    const ref = firestore.collection('vehicules').doc();
    const vehiculeData = {
      id: ref.id, agenceId, nom, type,
      capacite: capaciteNum,
      chauffeurNom: chauffeurNom || null,
      chauffeurTel: chauffeurTel || null,
      actif: true,
      createdAt: new Date().toISOString(),
    };
    await ref.set(vehiculeData);
    return res.status(201).json({ message: 'Véhicule créé.', vehicule: vehiculeData });
  } catch (err) {
    console.error('Erreur création véhicule :', err);
    return res.status(500).json({ message: 'Erreur serveur.' });
  }
});

// ════════════════════════════════
//  RÉCUPÉRER LES VÉHICULES D'UNE AGENCE
//  GET /vehicules?agenceId=xxx
// ════════════════════════════════
router.get('/all', verifierToken, verifierRole('admin'), async (req, res) => {
  const { agenceId } = req.query;
  if (!agenceId) return res.status(400).json({ message: 'agenceId manquant.' });
  if (req.user.agenceId !== agenceId) {
    return res.status(403).json({ message: 'Accès refusé à cette agence.' });
  }
  try {
    const snapshot = await firestore.collection('vehicules')
      .where('agenceId', '==', agenceId).orderBy('createdAt', 'desc').get();
    return res.status(200).json({ vehicules: snapshot.docs.map(d => d.data()) });
  } catch (err) {
    console.error('Erreur récupération véhicules :', err);
    return res.status(500).json({ message: 'Erreur serveur.' });
  }
});

// ════════════════════════════════
//  RÉCUPÉRER UN VÉHICULE PAR ID
//  GET /vehicule/:vehiculeId
// ════════════════════════════════
router.get('/:vehiculeId', verifierToken, verifierRole('admin'), async (req, res) => {
  try {
    const doc = await firestore.collection('vehicules').doc(req.params.vehiculeId).get();
    if (!doc.exists) return res.status(404).json({ message: 'Véhicule introuvable.' });
    if (req.user.agenceId !== doc.data().agenceId) {
      return res.status(403).json({ message: 'Accès refusé à ce véhicule.' });
    }
    return res.status(200).json(doc.data());
  } catch (err) {
    console.error('Erreur récupération véhicule :', err);
    return res.status(500).json({ message: 'Erreur serveur.' });
  }
});

// ════════════════════════════════
//  MODIFIER UN VÉHICULE — propage à tous les bus liés
//  PATCH /vehicule/:vehiculeId
// ════════════════════════════════
router.patch('/:vehiculeId', verifierToken, verifierRole('admin'), async (req, res) => {
  const { vehiculeId } = req.params;
  const { nom, type, capacite, chauffeurNom, chauffeurTel } = req.body;
  if (!nom || !type || !capacite) {
    return res.status(400).json({ message: 'Champs obligatoires manquants.' });
  }
  if (typeof nom !== 'string' || nom.trim().length < 1 || nom.length > 100) {
    return res.status(400).json({ message: 'Nom du véhicule invalide.' });
  }
  if (typeof type !== 'string' || type.length > 50) {
    return res.status(400).json({ message: 'Type de véhicule invalide.' });
  }
  const capaciteNum = Number(capacite);
  if (!Number.isInteger(capaciteNum) || capaciteNum <= 0 || capaciteNum > 200) {
    return res.status(400).json({ message: 'Capacité invalide.' });
  }
  if (chauffeurNom !== undefined && chauffeurNom !== null && (typeof chauffeurNom !== 'string' || chauffeurNom.length > 100)) {
    return res.status(400).json({ message: 'Nom du chauffeur invalide.' });
  }
  if (chauffeurTel !== undefined && chauffeurTel !== null && chauffeurTel !== '' && (typeof chauffeurTel !== 'string' || !/^\+?[0-9]{6,15}$/.test(chauffeurTel.replace(/\s/g, '')))) {
    return res.status(400).json({ message: 'Téléphone du chauffeur invalide.' });
  }
  try {
    const vDoc = await firestore.collection('vehicules').doc(vehiculeId).get();
    if (!vDoc.exists) return res.status(404).json({ message: 'Véhicule introuvable.' });
    if (req.user.agenceId !== vDoc.data().agenceId) {
      return res.status(403).json({ message: 'Accès refusé à ce véhicule.' });
    }
    if (!(await essaiEstActif(vDoc.data().agenceId))) {
      return res.status(403).json({ message: "Période d'essai expirée.", code: 'ESSAI_EXPIRE' });
    }

    const updateData = { nom, type, capacite: capaciteNum, chauffeurNom: chauffeurNom || null, chauffeurTel: chauffeurTel || null, updatedAt: new Date().toISOString() };
    await firestore.collection('vehicules').doc(vehiculeId).update(updateData);

    const departsSnap = await firestore.collection('departs').where('vehiculeId', '==', vehiculeId).get();
    const today = todayBrazza()
    const batch = creerBatchAutoCommit(firestore);

    for (const departDoc of departsSnap.docs) {
      await batch.update(departDoc.ref, {
        busNom: nom, busType: type, busCapacite: capaciteNum,
        updatedAt: new Date().toISOString(),
      });
      const sessionsSnap = await firestore.collection('sessions')
        .where('departId', '==', departDoc.id).where('date', '>=', today).get();
      for (const sDoc of sessionsSnap.docs) {
        const s = sDoc.data();
        if (s.statut === 'annulée') continue;
        await batch.update(sDoc.ref, {
          busNom: nom,
          placesTotal: capaciteNum,
          placesRestantes: Math.max(0, capaciteNum - (s.placesVendues || 0)),
          updatedAt: new Date().toISOString(),
        });
      }
    }
    await batch.commitFinal();
    return res.status(200).json({ message: 'Véhicule mis à jour sur tous ses trajets.', vehicule: updateData });
  } catch (err) {
    console.error('Erreur update véhicule :', err);
    return res.status(500).json({ message: 'Erreur serveur.' });
  }
});

// ════════════════════════════════
//  STATUT — cascade sur TOUS les trajets
//  PATCH /vehicule/:vehiculeId/statut
// ════════════════════════════════
router.patch('/:vehiculeId/statut', verifierToken, verifierRole('admin'), async (req, res) => {
  const { vehiculeId } = req.params;
  const { actif } = req.body;
  if (typeof actif !== 'boolean') return res.status(400).json({ message: 'actif doit être boolean.' });

  try {
    const vDoc = await firestore.collection('vehicules').doc(vehiculeId).get();
    if (!vDoc.exists) return res.status(404).json({ message: 'Véhicule introuvable.' });
    if (req.user.agenceId !== vDoc.data().agenceId) {
      return res.status(403).json({ message: 'Accès refusé à ce véhicule.' });
    }
    if (!(await essaiEstActif(vDoc.data().agenceId))) {
      return res.status(403).json({ message: "Période d'essai expirée.", code: 'ESSAI_EXPIRE' });
    }

    const today = todayBrazza();

    if (actif === false) {
      const blocage = await verifierImpactReservationsVehicule(vehiculeId, today);
      if (blocage.sessions.length > 0) {
        return res.status(409).json({
          code: 'RESA_BLOQUANTES',
          message: `Ce bus a ${blocage.totalReservations} réservation(s) future(s) sur ${blocage.sessions.length} session(s), réparties sur plusieurs trajets. Choisissez une action avant de continuer.`,
          sessions: blocage.sessions,
        });
      }
    }

    await firestore.collection('vehicules').doc(vehiculeId).update({ actif, updatedAt: new Date().toISOString() });
    const departsSnap = await firestore.collection('departs').where('vehiculeId', '==', vehiculeId).get();
    let departsAffectes = 0, sessionsSupprimees = 0;
    const batch = creerBatchAutoCommit(firestore);

    for (const departDoc of departsSnap.docs) {
      const depart = departDoc.data();
      // Si le bus est réactivé mais que son trajet est encore désactivé (desactiveParTrajet),
      // on ne le remet pas actif — sinon on court-circuite la désactivation du trajet.
      if (actif === true && depart.desactiveParTrajet === true) {
        continue;
      }
      await batch.update(departDoc.ref, { actif, updatedAt: new Date().toISOString() });
      departsAffectes++;
      if (actif === false) {
        const sessionsSnap = await firestore.collection('sessions')
          .where('departId', '==', departDoc.id).where('date', '>=', today).get();
        for (const sDoc of sessionsSnap.docs) {
          if (sDoc.data().statut !== 'annulée') { await batch.delete(sDoc.ref); sessionsSupprimees++; }
        }
      }
    }
    await batch.commitFinal();

    return res.status(200).json({
      message: actif
        ? `Véhicule réactivé sur ${departsAffectes} trajet(s).`
        : `Véhicule désactivé sur ${departsAffectes} trajet(s). ${sessionsSupprimees} session(s) future(s) supprimée(s).`,
      departsAffectes, sessionsSupprimees,
    });
  } catch (err) {
    console.error('Erreur statut véhicule :', err);
    return res.status(500).json({ message: 'Erreur serveur.' });
  }
});

// ════════════════════════════════
//  SUPPRIMER UN VÉHICULE — cascade sur TOUS les trajets
//  DELETE /vehicule/:vehiculeId
// ════════════════════════════════
router.delete('/:vehiculeId', verifierToken, verifierRole('admin'), async (req, res) => {
  const { vehiculeId } = req.params;
  try {
    const vDoc = await firestore.collection('vehicules').doc(vehiculeId).get();
    if (!vDoc.exists) return res.status(404).json({ message: 'Véhicule introuvable.' });
    if (req.user.agenceId !== vDoc.data().agenceId) {
      return res.status(403).json({ message: 'Accès refusé à ce véhicule.' });
    }
    if (!(await essaiEstActif(vDoc.data().agenceId))) {
      return res.status(403).json({ message: "Période d'essai expirée.", code: 'ESSAI_EXPIRE' });
    }

    const today = todayBrazza();

    const blocage = await verifierImpactReservationsVehicule(vehiculeId, today);
    if (blocage.sessions.length > 0) {
      return res.status(409).json({
        code: 'RESA_BLOQUANTES',
        message: `Ce bus a ${blocage.totalReservations} réservation(s) future(s) sur ${blocage.sessions.length} session(s), réparties sur plusieurs trajets. Choisissez une action avant de continuer.`,
        sessions: blocage.sessions,
      });
    }

    const departsSnap = await firestore.collection('departs').where('vehiculeId', '==', vehiculeId).get();
    let futuresSupprimees = 0, passeesArchivees = 0;
    const batch = creerBatchAutoCommit(firestore);

    for (const departDoc of departsSnap.docs) {
      const depart = departDoc.data();
      const sessionsSnap = await firestore.collection('sessions').where('departId', '==', departDoc.id).get();

      for (const sDoc of sessionsSnap.docs) {
        const s = sDoc.data();
        if (s.date >= today && s.statut !== 'annulée') {
          await batch.delete(sDoc.ref);
          futuresSupprimees++;
        } else {
          await batch.update(sDoc.ref, {
            departSupprime: true, departNom: depart.busNom,
            archivedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
          });
          passeesArchivees++;
        }
      }
      await batch.delete(departDoc.ref);
    }
    await batch.delete(firestore.collection('vehicules').doc(vehiculeId));
    await batch.commitFinal();

    return res.status(200).json({
      message: `Véhicule supprimé de ${departsSnap.size} trajet(s). ${futuresSupprimees} session(s) future(s) supprimée(s), ${passeesArchivees} conservée(s) dans l'historique.`,
      futuresSupprimees, passeesArchivees,
    });
  } catch (err) {
    console.error('Erreur suppression véhicule :', err);
    return res.status(500).json({ message: 'Erreur serveur.' });
  }
});

// ════════════════════════════════
//  LISTE DES CHAUFFEURS (dédupliquée par téléphone)
//  GET /vehicule/chauffeurs/liste?agenceId=xxx
// ════════════════════════════════
router.get('/chauffeurs/liste', verifierToken, verifierRole('admin'), async (req, res) => {
  const { agenceId } = req.query;
  if (!agenceId) return res.status(400).json({ message: 'agenceId manquant.' });
  if (req.user.agenceId !== agenceId) {
    return res.status(403).json({ message: 'Accès refusé à cette agence.' });
  }
  try {
    const snapshot = await firestore.collection('vehicules').where('agenceId', '==', agenceId).get();
    const vus = new Map();
    snapshot.docs.forEach(d => {
      const v = d.data();
      if (!v.chauffeurTel) return;
      if (!vus.has(v.chauffeurTel)) {
        vus.set(v.chauffeurTel, { nom: v.chauffeurNom || null, tel: v.chauffeurTel, bus: [] });
      }
      vus.get(v.chauffeurTel).bus.push(v.nom);
    });
    return res.status(200).json({ chauffeurs: Array.from(vus.values()) });
  } catch (err) {
    console.error('Erreur récupération chauffeurs :', err);
    return res.status(500).json({ message: 'Erreur serveur.' });
  }
});

module.exports = router;