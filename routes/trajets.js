const express = require('express');
const router  = express.Router();
const { essaiEstActif } = require('../helpers/essai');

const { firestore } = require('../firebase');
const { todayBrazza } = require('../helpers/dates');
const { checkEssai } = require('../helpers/essai');
const { verifierImpactReservationsTrajet } = require('../helpers/reservations-impact');
const { verifierToken } = require('../middlewares/verifierToken');
const { verifierRole } = require('../middlewares/verifierRole');
const { creerBatchAutoCommit } = require('../helpers/batch');

// ════════════════════════════════
//  CRÉER UN TRAJET
//  POST /trajet/create
// ════════════════════════════════
router.post('/create', verifierToken, verifierRole('admin'), checkEssai, async (req, res) => {
  const {
    agenceId, villeDepart, villeArrivee, typeTrajet,
    arrets, pdvDepart, pdvArrivee, pdvArrets, prixAdulte,
    prixEnfant, limiteBagages, fraisExcesBagages,
  } = req.body;

  const { prixParType } = req.body;
  if (req.user.agenceId !== agenceId) {
    return res.status(403).json({ message: 'Accès refusé à cette agence.' });
  }

  if (!agenceId || !villeDepart || !villeArrivee || !typeTrajet ||
    !prixParType || Object.keys(prixParType).length === 0) {
    return res.status(400).json({ message: 'Champs obligatoires manquants.' });
  }
  if (typeof villeDepart !== 'string' || villeDepart.trim().length < 2 || villeDepart.length > 100) {
    return res.status(400).json({ message: 'Ville de départ invalide.' });
  }
  if (typeof villeArrivee !== 'string' || villeArrivee.trim().length < 2 || villeArrivee.length > 100) {
    return res.status(400).json({ message: 'Ville d\'arrivée invalide.' });
  }
  if (typeof typeTrajet !== 'string' || typeTrajet.length > 50) {
    return res.status(400).json({ message: 'Type de trajet invalide.' });
  }
  if (typeof prixParType !== 'object' || Array.isArray(prixParType) || Object.values(prixParType).some(v => !Number.isFinite(Number(v)) || Number(v) < 0)) {
    return res.status(400).json({ message: 'prixParType invalide — toutes les valeurs doivent être des nombres positifs.' });
  }
  if (arrets !== undefined && !Array.isArray(arrets)) {
    return res.status(400).json({ message: 'arrets doit être un tableau.' });
  }
  if (pdvDepart !== undefined && !Array.isArray(pdvDepart)) {
    return res.status(400).json({ message: 'pdvDepart doit être un tableau.' });
  }
  if (pdvArrivee !== undefined && !Array.isArray(pdvArrivee)) {
    return res.status(400).json({ message: 'pdvArrivee doit être un tableau.' });
  }
  if (pdvArrets !== undefined && !Array.isArray(pdvArrets)) {
    return res.status(400).json({ message: 'pdvArrets doit être un tableau.' });
  }
  if (limiteBagages !== undefined && limiteBagages !== null && !Number.isFinite(Number(limiteBagages))) {
    return res.status(400).json({ message: 'limiteBagages invalide.' });
  }
  if (fraisExcesBagages !== undefined && fraisExcesBagages !== null && !Number.isFinite(Number(fraisExcesBagages))) {
    return res.status(400).json({ message: 'fraisExcesBagages invalide.' });
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
//  SUPPRIMER UN TRAJET
//  DELETE /trajet/:trajetId
// ════════════════════════════════
router.delete('/:trajetId', verifierToken, verifierRole('admin'), async (req, res) => {
  const { trajetId } = req.params;

  try {
    const trajetDoc = await firestore.collection('trajets').doc(trajetId).get();
    if (!trajetDoc.exists) return res.status(404).json({ message: 'Trajet introuvable.' });

    const trajet  = trajetDoc.data();

    if (req.user.agenceId !== trajet.agenceId) {
      return res.status(403).json({ message: 'Accès refusé à ce trajet.' });
    }

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
router.patch('/:trajetId', verifierToken, verifierRole('admin'), async (req, res) => {
  const { trajetId } = req.params;
  const {
    prixParType,
    limiteBagages, fraisExcesBagages,
    arrets,
    pdvDepart, pdvArrivee,
  } = req.body;

  try {
    const trajetDocCheck = await firestore.collection('trajets').doc(trajetId).get();
    if (!trajetDocCheck.exists) return res.status(404).json({ message: 'Trajet introuvable.' });

    if (req.user.agenceId !== trajetDocCheck.data().agenceId) {
      return res.status(403).json({ message: 'Accès refusé à ce trajet.' });
    }

    if (!prixParType || Object.keys(prixParType).length === 0) {
      return res.status(400).json({ message: 'Champs obligatoires manquants.' });
    }
    if (typeof prixParType !== 'object' || Array.isArray(prixParType) || Object.values(prixParType).some(v => !Number.isFinite(Number(v)) || Number(v) < 0)) {
      return res.status(400).json({ message: 'prixParType invalide — toutes les valeurs doivent être des nombres positifs.' });
    }
    if (limiteBagages !== undefined && limiteBagages !== null && !Number.isFinite(Number(limiteBagages))) {
      return res.status(400).json({ message: 'limiteBagages invalide.' });
    }
    if (fraisExcesBagages !== undefined && fraisExcesBagages !== null && !Number.isFinite(Number(fraisExcesBagages))) {
      return res.status(400).json({ message: 'fraisExcesBagages invalide.' });
    }
    if (arrets !== undefined && !Array.isArray(arrets)) {
      return res.status(400).json({ message: 'arrets doit être un tableau.' });
    }

    if (!(await essaiEstActif(trajetDocCheck.data().agenceId))) {
      return res.status(403).json({ message: "Période d'essai expirée.", code: 'ESSAI_EXPIRE' });
    }

    if (pdvDepart !== undefined) {
      if (!Array.isArray(pdvDepart) || pdvDepart.length === 0) {
        return res.status(400).json({ message: 'Sélectionnez au moins un PDV de départ.' });
      }
      const idsDepart = pdvDepart.map(p => p.id);
      const docsDepart = await firestore.getAll(
        ...idsDepart.map(id => firestore.collection('pointsDeVente').doc(id))
      );
      const invalideDepart = docsDepart.some(
        d => !d.exists || d.data().agenceId !== trajetDocCheck.data().agenceId
      );
      if (invalideDepart) {
        return res.status(400).json({ message: 'Un ou plusieurs PDV de départ sont invalides.' });
      }
    }

    if (pdvArrivee !== undefined && Array.isArray(pdvArrivee) && pdvArrivee.length > 0) {
      const idsArrivee = pdvArrivee.map(p => p.id);
      const docsArrivee = await firestore.getAll(
        ...idsArrivee.map(id => firestore.collection('pointsDeVente').doc(id))
      );
      const invalideArrivee = docsArrivee.some(
        d => !d.exists || d.data().agenceId !== trajetDocCheck.data().agenceId
      );
      if (invalideArrivee) {
        return res.status(400).json({ message: 'Un ou plusieurs PDV d\'arrivée sont invalides.' });
      }
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
      ...(pdvDepart !== undefined && { pdvDepart }),
      ...(pdvArrivee !== undefined && { pdvArrivee }),
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

        // ── Reconstruire les bornes AVANT et APRÈS pour remapper les segments correctement ──
        const ancienPoints  = ['__DEPART__', ...(session.arretsActifs || []).map(a => a.nom), '__ARRIVEE__'];
        const nouveauPoints = ['__DEPART__', ...arretsActifsFiltres.map(a => a.nom), '__ARRIVEE__'];

        const ancientableau = session.placesVenduesSegments || [];

        // Pour chaque nouveau segment [nouveauPoints[j] -> nouveauPoints[j+1]],
        // on additionne tous les anciens segments compris entre ces deux mêmes bornes
        const nouveauTableau = [];
        for (let j = 0; j < nouveauPoints.length - 1; j++) {
          const idxDebut = ancienPoints.indexOf(nouveauPoints[j]);
          const idxFin   = ancienPoints.indexOf(nouveauPoints[j + 1]);

          let somme = 0;
          if (idxDebut !== -1 && idxFin !== -1 && idxFin > idxDebut) {
            // Les deux péages existaient déjà avant → on fusionne les vraies ventes
            for (let k = idxDebut; k < idxFin; k++) {
              somme += ancientableau[k] ?? 0;
            }
          } else if (idxDebut === -1 || idxFin === -1) {
            // Au moins un des deux péages est TOUT NOUVEAU (n'existait pas avant)
            // → personne n'a pu acheter sur ce bout de route, donc 0 obligatoirement
            somme = 0;
          } else {
            // Cas résiduel improbable (ordre incohérent) → sécurité minimale
            somme = ancientableau[j] ?? 0;
          }
          nouveauTableau.push(somme);
        }

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
router.get('/:trajetId/stats', verifierToken, verifierRole('admin'), async (req, res) => {
  const { trajetId } = req.params;
  const { dateDebut, dateFin } = req.query;

  const OFFSET_MS = 1 * 60 * 60 * 1000;
  const defautFin   = new Date(Date.now() + OFFSET_MS).toISOString().split('T')[0];
  const defautDebut = new Date(Date.now() + OFFSET_MS - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const debut = dateDebut || defautDebut;
  const fin   = dateFin   || defautFin;

  try {
    const trajetDoc = await firestore.collection('trajets').doc(trajetId).get();
    if (!trajetDoc.exists) return res.status(404).json({ message: 'Trajet introuvable.' });

    if (req.user.agenceId !== trajetDoc.data().agenceId) {
      return res.status(403).json({ message: 'Accès refusé à ce trajet.' });
    }

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
router.patch('/:trajetId/statut', verifierToken, verifierRole('admin'), async (req, res) => {
  const { trajetId } = req.params;
  const { actif } = req.body;

  try {
    const trajetDocCheck = await firestore.collection('trajets').doc(trajetId).get();
    if (!trajetDocCheck.exists) return res.status(404).json({ message: 'Trajet introuvable.' });

    if (req.user.agenceId !== trajetDocCheck.data().agenceId) {
      return res.status(403).json({ message: 'Accès refusé à ce trajet.' });
    }

    if (typeof actif !== 'boolean') {
      return res.status(400).json({ message: 'Le champ actif doit être true ou false.' });
    }

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
        // On ne marque "désactivé par le trajet" que si le bus était actif avant —
        // ça permet de ne pas réactiver par erreur un bus déjà désactivé manuellement.
        const etaitActifAvant = depart.actif !== false;

        await batch.update(departDoc.ref, {
          actif: false,
          ...(etaitActifAvant && { desactiveParTrajet: true }),
          updatedAt: new Date().toISOString(),
        });
        if (etaitActifAvant) busDesactives++;

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
        const depart = doc.data();
        // On ne réactive que les bus désactivés à cause de ce trajet —
        // ceux désactivés manuellement par l'admin restent inchangés.
        if (depart.desactiveParTrajet === true) {
          await batch.update(doc.ref, {
            actif: true,
            desactiveParTrajet: false,
            updatedAt: new Date().toISOString(),
          });
          busDesactives++;
        }
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