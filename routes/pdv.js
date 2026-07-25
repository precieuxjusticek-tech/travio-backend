const express = require('express');
const router  = express.Router();
const { essaiEstActif } = require('../helpers/essai');

const { auth, firestore } = require('../firebase');
const { checkEssai } = require('../helpers/essai');

// ════════════════════════════════
//  CRÉER UN PDV
//  POST /pdv/create
// ════════════════════════════════
router.post('/create', checkEssai, async (req, res) => {
  const {
    agenceId, ville, nom, adresse, telephone,
    responsable, emailContact, emailConnexion, password,
  } = req.body;

  if (!agenceId || !ville || !nom || !adresse || !telephone || !responsable || !emailConnexion || !password) {
    return res.status(400).json({ message: 'Champs obligatoires manquants.' });
  }

  if (password.length < 6) {
    return res.status(400).json({ message: 'Le mot de passe doit faire au moins 6 caractères.' });
  }

  try {
    const userRecord = await auth.createUser({
      email:       emailConnexion,
      password,
      displayName: responsable,
    });

    const pdvRef = firestore.collection('pointsDeVente').doc();
    const pdvId  = pdvRef.id;

    const pdvData = {
      id:             pdvId,
      agenceId,
      ville,
      nom,
      adresse,
      telephone,
      responsable,
      emailContact:   emailContact   || null,
      emailConnexion,
      password: password,
      agentUid:       userRecord.uid,
      quota:          0,
      vendus:         0,
      actif:          true,
      createdAt:      new Date().toISOString(),
    };

    await pdvRef.set(pdvData);

    await firestore.collection('users').doc(userRecord.uid).set({
      prenom:    responsable,
      nom:       '',
      email:     emailConnexion,
      role:      'agent',
      agenceId,
      pdvId,
      createdAt: new Date().toISOString(),
    });

    return res.status(201).json({
      message: 'Point de vente créé avec succès.',
      pdv:     pdvData,
    });

  } catch (error) {
    if (error.code === 'auth/email-already-exists') {
      return res.status(409).json({ message: 'Cet email de connexion est déjà utilisé.' });
    }
    console.error('Erreur création PDV :', error);
    return res.status(500).json({ message: 'Erreur serveur, réessayez.' });
  }
});

// ════════════════════════════════
//  RÉCUPÉRER LES PDV D'UNE AGENCE
//  GET /pdv?agenceId=xxx
// ════════════════════════════════
router.get('/', async (req, res) => {
  const { agenceId } = req.query;

  if (!agenceId) {
    return res.status(400).json({ message: 'agenceId manquant.' });
  }

  try {
    const snapshot = await firestore
      .collection('pointsDeVente')
      .where('agenceId', '==', agenceId)
      .orderBy('createdAt', 'desc')
      .get();

    const pdvs = snapshot.docs.map(doc => doc.data());

    return res.status(200).json({ pdvs });

  } catch (error) {
    console.error('Erreur récupération PDV :', error);
    return res.status(500).json({ message: 'Erreur serveur, réessayez.' });
  }
});

// ════════════════════════════════
//  RÉCUPÉRER UN PDV PAR ID
//  GET /pdv/:pdvId
// ════════════════════════════════
router.get('/:pdvId', async (req, res) => {
  const { pdvId } = req.params;

  try {
    const doc = await firestore.collection('pointsDeVente').doc(pdvId).get();

    if (!doc.exists) {
      return res.status(404).json({ message: 'PDV introuvable.' });
    }

    return res.status(200).json(doc.data());

  } catch (error) {
    console.error('Erreur récupération PDV :', error);
    return res.status(500).json({ message: 'Erreur serveur, réessayez.' });
  }
});

// ════════════════════════════════
//  MODIFIER UN PDV
//  PATCH /pdv/:pdvId
// ════════════════════════════════
router.patch('/:pdvId', async (req, res) => {
  const { pdvId } = req.params;
  const { nom, ville, adresse, responsable, telephone, emailContact, emailConnexion } = req.body;

  if (!nom || !ville || !adresse || !responsable || !telephone || !emailConnexion) {
    return res.status(400).json({ message: 'Champs obligatoires manquants.' });
  }

  try {
    const doc = await firestore.collection('pointsDeVente').doc(pdvId).get();
    if (!doc.exists) return res.status(404).json({ message: 'PDV introuvable.' });

    const { agentUid } = doc.data();

    if (!(await essaiEstActif(doc.data().agenceId))) {
      return res.status(403).json({ message: "Période d'essai expirée.", code: 'ESSAI_EXPIRE' });
    }

    if (agentUid && emailConnexion !== doc.data().emailConnexion) {
      await auth.updateUser(agentUid, { email: emailConnexion, displayName: responsable });
    }

    const updateData = {
      nom, ville, adresse, responsable, telephone,
      emailContact:   emailContact   || null,
      emailConnexion,
      updatedAt: new Date().toISOString(),
    };

    await firestore.collection('pointsDeVente').doc(pdvId).update(updateData);

    return res.status(200).json({ message: 'PDV mis à jour.', pdv: updateData });

  } catch (err) {
    if (err.code === 'auth/email-already-exists') {
      return res.status(409).json({ message: 'Cet email de connexion est déjà utilisé.' });
    }
    console.error('Erreur update PDV :', err);
    return res.status(500).json({ message: 'Erreur serveur, réessayez.' });
  }
});

// ════════════════════════════════
//  DÉSACTIVER / ACTIVER UN PDV
//  PATCH /pdv/:pdvId/statut
// ════════════════════════════════
router.patch('/:pdvId/statut', async (req, res) => {
  const { pdvId }  = req.params;
  const { actif }  = req.body;

  if (typeof actif !== 'boolean') {
    return res.status(400).json({ message: 'Le champ actif doit être true ou false.' });
  }

  try {
    const docCheck = await firestore.collection('pointsDeVente').doc(pdvId).get();
    if (!docCheck.exists) return res.status(404).json({ message: 'PDV introuvable.' });
    if (!(await essaiEstActif(docCheck.data().agenceId))) {
      return res.status(403).json({ message: "Période d'essai expirée.", code: 'ESSAI_EXPIRE' });
    }

    await firestore.collection('pointsDeVente').doc(pdvId).update({ actif });

    const doc = await firestore.collection('pointsDeVente').doc(pdvId).get();
    if (doc.exists && doc.data().agentUid) {
      await auth.updateUser(doc.data().agentUid, { disabled: !actif });
    }

    return res.status(200).json({
      message: actif ? 'PDV activé.' : 'PDV désactivé.',
    });

  } catch (error) {
    console.error('Erreur statut PDV :', error);
    return res.status(500).json({ message: 'Erreur serveur, réessayez.' });
  }
});

// ════════════════════════════════
//  RÉINITIALISER LE MOT DE PASSE AGENT
//  PATCH /pdv/:pdvId/reset-password
// ════════════════════════════════
router.patch('/:pdvId/reset-password', async (req, res) => {
  const { pdvId }       = req.params;
  const { newPassword } = req.body;

  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ message: 'Mot de passe trop court (min. 6 caractères).' });
  }

  try {
    const doc = await firestore.collection('pointsDeVente').doc(pdvId).get();

    if (!doc.exists) {
      return res.status(404).json({ message: 'PDV introuvable.' });
    }

    const { agentUid } = doc.data();

    if (!(await essaiEstActif(doc.data().agenceId))) {
      return res.status(403).json({ message: "Période d'essai expirée.", code: 'ESSAI_EXPIRE' });
    }

    if (!agentUid) {
      return res.status(400).json({ message: 'Aucun agent associé à ce PDV.' });
    }

    await auth.updateUser(agentUid, { password: newPassword });

    return res.status(200).json({ message: 'Mot de passe réinitialisé avec succès.' });

  } catch (error) {
    console.error('Erreur reset password :', error);
    return res.status(500).json({ message: 'Erreur serveur, réessayez.' });
  }
});

// ════════════════════════════════
//  ASSIGNER UN QUOTA
//  PATCH /pdv/:pdvId/quota
// ════════════════════════════════
router.patch('/:pdvId/quota', async (req, res) => {
  const { pdvId } = req.params;
  const { quota } = req.body;

  if (typeof quota !== 'number' || quota < 0) {
    return res.status(400).json({ message: 'Quota invalide.' });
  }

  try {
    const docCheck = await firestore.collection('pointsDeVente').doc(pdvId).get();
    if (!docCheck.exists) return res.status(404).json({ message: 'PDV introuvable.' });
    if (!(await essaiEstActif(docCheck.data().agenceId))) {
      return res.status(403).json({ message: "Période d'essai expirée.", code: 'ESSAI_EXPIRE' });
    }

    await firestore.collection('pointsDeVente').doc(pdvId).update({ quota });

    return res.status(200).json({ message: `Quota mis à jour : ${quota} places.` });

  } catch (error) {
    console.error('Erreur quota PDV :', error);
    return res.status(500).json({ message: 'Erreur serveur, réessayez.' });
  }
});

// ════════════════════════════════
//  SUPPRIMER UN PDV
//  DELETE /pdv/:pdvId
// ════════════════════════════════
router.delete('/:pdvId', async (req, res) => {
  const { pdvId } = req.params;

  try {
    const doc = await firestore.collection('pointsDeVente').doc(pdvId).get();

    if (!doc.exists) {
      return res.status(404).json({ message: 'PDV introuvable.' });
    }

    const { agentUid } = doc.data();

    if (!(await essaiEstActif(doc.data().agenceId))) {
      return res.status(403).json({ message: "Période d'essai expirée.", code: 'ESSAI_EXPIRE' });
    }

    if (agentUid) {
      try {
        await auth.deleteUser(agentUid);
      } catch (authErr) {
        console.warn('Compte Auth déjà supprimé ou introuvable :', authErr.message);
      }

      await firestore.collection('users').doc(agentUid).delete();
    }

    await firestore.collection('pointsDeVente').doc(pdvId).delete();

    return res.status(200).json({ message: 'PDV supprimé avec succès.' });

  } catch (error) {
    console.error('Erreur suppression PDV :', error);
    return res.status(500).json({ message: 'Erreur serveur, réessayez.' });
  }
});

// ════════════════════════════════
//  TRAJETS D'UN PDV
//  GET /pdv/:pdvId/trajets
// ════════════════════════════════
router.get('/:pdvId/trajets', async (req, res) => {
  const { pdvId } = req.params;
  const { agenceId } = req.query;

  if (!agenceId) return res.status(400).json({ message: 'agenceId manquant.' });

  try {
    const snapshot = await firestore
      .collection('trajets')
      .where('agenceId', '==', agenceId)
      .where('actif', '==', true)
      .get();

    const trajets = snapshot.docs
      .map(doc => doc.data())
      .filter(t =>
        (t.pdvDepart || []).some(p => p.id === pdvId) ||
        (t.pdvArrets || []).some(p => p.id === pdvId)
      )

    return res.status(200).json({ trajets });

  } catch (err) {
    console.error('Erreur trajets PDV :', err);
    return res.status(500).json({ message: 'Erreur serveur.' });
  }
});

// ════════════════════════════════
//  PLACES DISPONIBLES AUJOURD'HUI POUR UN PDV
//  GET /pdv/:pdvId/places-dispo?agenceId=xxx&date=2026-07-05
// ════════════════════════════════
router.get('/:pdvId/places-dispo', async (req, res) => {
  const { pdvId } = req.params;
  const { agenceId, date } = req.query;

  if (!agenceId || !date) {
    return res.status(400).json({ message: 'agenceId et date obligatoires.' });
  }

  try {
    const trajetsSnap = await firestore
      .collection('trajets')
      .where('agenceId', '==', agenceId)
      .where('actif', '==', true)
      .get();

    const trajets = trajetsSnap.docs
      .map(d => d.data())
      .filter(t =>
        (t.pdvDepart || []).some(p => p.id === pdvId) ||
        (t.pdvArrets || []).some(p => p.id === pdvId)
      );

    if (trajets.length === 0) {
      return res.status(200).json({ placesDispo: 0 });
    }

    const trajetIds = trajets.map(t => t.id);

    const chunk = (arr, size) => Array.from({ length: Math.ceil(arr.length / size) }, (_, i) => arr.slice(i * size, i * size + size));
    const trajetChunks = chunk(trajetIds, 10);

    let departs = [];
    for (const ids of trajetChunks) {
      const snap = await firestore.collection('departs').where('trajetId', 'in', ids).get();
      departs.push(...snap.docs.map(d => d.data()).filter(d => d.actif !== false));
    }

    if (departs.length === 0) {
      return res.status(200).json({ placesDispo: 0 });
    }

    const departIds = departs.map(d => d.id);
    const departChunks = chunk(departIds, 10);

    let placesDispo = 0;
    for (const ids of departChunks) {
      const snap = await firestore.collection('sessions')
        .where('departId', 'in', ids)
        .where('date', '==', date)
        .get();

      snap.docs.forEach(d => {
        const s = d.data();
        if (s.statut !== 'annulée') {
          placesDispo += (s.placesRestantes ?? 0);
        }
      });
    }

    return res.status(200).json({ placesDispo });

  } catch (err) {
    console.error('Erreur places dispo PDV :', err);
    return res.status(500).json({ message: 'Erreur serveur.' });
  }
});

// ════════════════════════════════
//  STATS D'UN PDV
//  GET /pdv/:pdvId/stats?agenceId=xxx
// ════════════════════════════════
router.get('/:pdvId/stats', async (req, res) => {
  const { pdvId }    = req.params;
  const { agenceId, dateDebut, dateFin, trajetId } = req.query;

  if (!agenceId) return res.status(400).json({ message: 'agenceId manquant.' });

  try {
    const OFFSET_MS = 1 * 60 * 60 * 1000;
    const defautTodayStr  = new Date(Date.now() + OFFSET_MS).toISOString().split('T')[0];
    const defautIlYA30    = new Date(Date.now() + OFFSET_MS - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    const todayStr  = dateFin   || defautTodayStr;
    const il_y_a_30 = dateDebut || defautIlYA30;

    const dureeMs   = new Date(todayStr).getTime() - new Date(il_y_a_30).getTime();
    const il_y_a_60 = new Date(new Date(il_y_a_30).getTime() - dureeMs).toISOString().split('T')[0];

    const trajetsSnap = await firestore
      .collection('trajets')
      .where('agenceId', '==', agenceId)
      .where('actif', '==', true)
      .get();

    const trajets = trajetsSnap.docs
      .map(d => d.data())
      .filter(t =>(t.pdvDepart || []).some(p => p.id === pdvId) ||
        (t.pdvArrets || []).some(p => p.id === pdvId)
      )
      .filter(t => !trajetId || t.id === trajetId);

    if (trajets.length === 0) {
      return res.status(200).json({
        trajets:          [],
        totalVendus:      0,
        tauxMoyen:        0,
        sessionsRecentes: [],
        revenuPeriode:    0,
        revenuVariation:  0,
        tauxVariation:    0,
        aDonneesRevenuPrecedent: false,
        aDonneesTauxPrecedent:   false,
      });
    }

    const trajetIds = trajets.map(t => t.id);

    const departsSnap = await firestore
      .collection('departs')
      .where('trajetId', 'in', trajetIds)
      .get();

    const departs = departsSnap.docs.map(d => d.data());

    const sessionsSnap = await firestore
      .collection('sessions')
      .where('trajetId', 'in', trajetIds)
      .where('date', '>=', il_y_a_30)
      .where('date', '<=', todayStr)
      .get();

    const sessions = sessionsSnap.docs.map(d => d.data());

    const resasPdvSnap = await firestore.collection('reservations')
      .where('pdvId', '==', pdvId)
      .where('statut', '!=', 'annulée')
      .get();

    const resasToutes = resasPdvSnap.docs.map(d => d.data());

    const resasPeriodeActuelle = resasToutes.filter(r =>
      (r.createdAt || '').split('T')[0] >= il_y_a_30 &&
      (r.createdAt || '').split('T')[0] <= todayStr
    );
    const resasPeriodePrecedente = resasToutes.filter(r =>
      (r.createdAt || '').split('T')[0] >= il_y_a_60 &&
      (r.createdAt || '').split('T')[0] < il_y_a_30
    );

    const sessionToDepart = {};
    sessions.forEach(s => { sessionToDepart[s.id] = s.departId; });

    const vendusParBus = {};
    resasPeriodeActuelle.forEach(r => {
      const departId = sessionToDepart[r.sessionId];
      if (!departId) return;
      vendusParBus[departId] = (vendusParBus[departId] || 0) + (r.nbPassagers || 1);
    });

    let totalVendusGlobal = 0;
    let totalCapaGlobal   = 0;

    const trajetsStats = trajets.map(t => {
      const busDeTrajet = departs.filter(d => d.trajetId === t.id);

      const busStats = busDeTrajet.map(bus => {
        const sessionsbus = sessions.filter(s =>
          s.departId === bus.id && s.statut !== 'annulée'
        );
        const vendus     = vendusParBus[bus.id] || 0;
        const capacite   = sessionsbus.reduce((acc, s) => acc + (s.placesTotal   || 0), 0);
        const taux       = capacite > 0 ? Math.round((vendus / capacite) * 100) : 0;
        const nbSessions = sessionsbus.length;

        return {
          id:             bus.id,
          nom:            bus.busNom,
          type:           bus.busType,
          capacite:       bus.busCapacite,
          heureDepart:    bus.heureDepart,
          heureArrivee:   bus.heureArrivee || null,
          tousLesJours:   bus.tousLesJours,
          jours:          bus.jours || [],
          actif:          bus.actif !== false,
          vendus,
          capaciteTotale: capacite,
          taux,
          nbSessions,
        };
      });

      const trajetVendus = busStats.reduce((acc, b) => acc + b.vendus, 0);
      const trajetCapa   = busStats.reduce((acc, b) => acc + b.capaciteTotale, 0);
      const trajetTaux   = trajetCapa > 0
        ? Math.round((trajetVendus / trajetCapa) * 100) : 0;

      totalVendusGlobal += trajetVendus;
      totalCapaGlobal   += trajetCapa;

      return {
        id:           t.id,
        villeDepart:  t.villeDepart,
        villeArrivee: t.villeArrivee,
        typeTrajet:   t.typeTrajet,
        estArret:     (t.pdvArrets || []).some(p => p.id === pdvId),
        vendus:       trajetVendus,
        taux:         trajetTaux,
        bus:          busStats,
      };
    });

    const tauxMoyen = totalCapaGlobal > 0
      ? Math.round((totalVendusGlobal / totalCapaGlobal) * 100) : 0;

    const sessionsRecentes = sessions
      .filter(s => s.statut !== 'annulée')
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 5)
      .map(s => {
        const bus    = departs.find(d => d.id === s.departId);
        const trajet = trajets.find(t => t.id === s.trajetId);
        return {
          date:          s.date,
          busNom:        bus?.busNom         || '—',
          villeDepart:   trajet?.villeDepart  || '—',
          villeArrivee:  trajet?.villeArrivee || '—',
          heureDepart:   s.heureDepart,
          placesVendues: s.placesVendues || 0,
          placesTotal:   s.placesTotal   || 0,
          taux: s.placesTotal > 0
            ? Math.round(((s.placesVendues || 0) / s.placesTotal) * 100) : 0,
        };
      });

    const revenuPeriode    = resasPeriodeActuelle.reduce((s, r) => s + (r.prixTotal || 0), 0);
    const revenuPrecedent  = resasPeriodePrecedente.reduce((s, r) => s + (r.prixTotal || 0), 0);

    const revenuVariation = revenuPrecedent > 0
      ? Math.round(((revenuPeriode - revenuPrecedent) / revenuPrecedent) * 100)
      : (revenuPeriode > 0 ? 100 : 0);
    const aDonneesRevenuPrecedent = resasPeriodePrecedente.length > 0;

    const sessionsPrecedentesSnap = await firestore.collection('sessions').where('trajetId', 'in', trajetIds)
      .where('date', '>=', il_y_a_60).where('date', '<', il_y_a_30).get();

    const sessionsPrecedentes = sessionsPrecedentesSnap.docs.map(d => d.data()).filter(s => s.statut !== 'annulée');

    const vendusPrecedent = sessionsPrecedentes.reduce((acc, s) => acc + (s.placesVendues || 0), 0);
    const capaPrecedente  = sessionsPrecedentes.reduce((acc, s) => acc + (s.placesTotal   || 0), 0);
    const tauxPrecedent   = capaPrecedente > 0 ? Math.round((vendusPrecedent / capaPrecedente) * 100) : 0;
    const tauxVariation   = tauxMoyen - tauxPrecedent;
    const aDonneesTauxPrecedent = sessionsPrecedentes.length > 0;

    const pdvDocStats    = await firestore.collection('pointsDeVente').doc(pdvId).get();
    const annulations    = pdvDocStats.exists ? (pdvDocStats.data().annulations || 0) : 0;
    const vendusTotal    = pdvDocStats.exists ? (pdvDocStats.data().vendus       || 0) : 0;
    const ventesNettes   = Math.max(0, vendusTotal - annulations);
    const tauxAnnulation = vendusTotal > 0 ? Math.round((annulations / vendusTotal) * 100) : 0;

    return res.status(200).json({
      trajets:          trajetsStats,
      totalVendus:      totalVendusGlobal,
      tauxMoyen,
      sessionsRecentes,
      revenuPeriode,
      revenuVariation,
      tauxVariation,
      aDonneesRevenuPrecedent,
      aDonneesTauxPrecedent,
      annulations,
      vendusTotal,
      ventesNettes,
      tauxAnnulation,
    });

  } catch (err) {
    console.error('Erreur stats PDV :', err);
    return res.status(500).json({ message: 'Erreur serveur.' });
  }
});

module.exports = router;