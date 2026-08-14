const express = require('express');
const router  = express.Router();
const { essaiEstActif } = require('../helpers/essai');

const { auth, firestore } = require('../firebase');
const { checkEssai } = require('../helpers/essai');
const { verifierToken } = require('../middlewares/verifierToken');
const { verifierRole } = require('../middlewares/verifierRole');
const { encrypt, decrypt } = require('../helpers/crypto');

const rateLimit = require('express-rate-limit');

const revealPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { message: 'Trop de tentatives, réessayez plus tard.' },
});

// ════════════════════════════════
//  CRÉER UN PDV
//  POST /pdv/create
// ════════════════════════════════
router.post('/create', verifierToken, verifierRole('admin'), checkEssai, async (req, res) => {
  const {
    agenceId, ville, nom, adresse, telephone,
    responsable, emailContact, emailConnexion, password,
  } = req.body;

  if (req.user.agenceId !== agenceId) {
    return res.status(403).json({ message: 'Accès refusé à cette agence.' });
  }

  if (!agenceId || !ville || !nom || !adresse || !telephone || !responsable || !emailConnexion || !password) {
    return res.status(400).json({ message: 'Champs obligatoires manquants.' });
  }
  if (typeof nom !== 'string' || nom.trim().length < 2 || nom.length > 100) {
    return res.status(400).json({ message: 'Nom du PDV invalide.' });
  }
  if (typeof ville !== 'string' || ville.trim().length < 2 || ville.length > 100) {
    return res.status(400).json({ message: 'Ville invalide.' });
  }
  if (typeof adresse !== 'string' || adresse.trim().length < 5 || adresse.length > 200) {
    return res.status(400).json({ message: 'Adresse invalide.' });
  }
  if (typeof telephone !== 'string' || !/^\+?[0-9]{6,15}$/.test(telephone.replace(/\s/g, ''))) {
    return res.status(400).json({ message: 'Numéro de téléphone invalide.' });
  }
  if (typeof responsable !== 'string' || responsable.trim().length < 2 || responsable.length > 100) {
    return res.status(400).json({ message: 'Nom du responsable invalide.' });
  }
  if (typeof emailConnexion !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailConnexion)) {
    return res.status(400).json({ message: 'Email de connexion invalide.' });
  }
  if (emailContact !== undefined && emailContact !== null && emailContact !== '' && (typeof emailContact !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailContact))) {
    return res.status(400).json({ message: 'Email de contact invalide.' });
  }
  if (typeof password !== 'string' || password.length < 6) {
    return res.status(400).json({ message: 'Le mot de passe doit faire au moins 6 caractères.' });
  }

  let pdvId;
  let userRecord;

  try {
    userRecord = await auth.createUser({
      email:       emailConnexion,
      password,
      displayName: responsable,
    });
  } catch (error) {
    if (error.code === 'auth/email-already-exists') {
      return res.status(409).json({ message: 'Cet email de connexion est déjà utilisé.' });
    }
    console.error('Erreur création compte Auth PDV :', error);
    return res.status(500).json({ message: 'Erreur serveur, réessayez.' });
  }

  try {
    try {

    const pdvRef = firestore.collection('pointsDeVente').doc();
    pdvId = pdvRef.id;

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
      password: encrypt(password),
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

    const { password: _pw, ...pdvSansPassword } = pdvData;

    return res.status(201).json({
      message: 'Point de vente créé avec succès.',
      pdv:     pdvSansPassword,
    });

    } catch (firestoreErr) {
      // Le compte Auth a été créé mais Firestore a échoué — on nettoie pour éviter un compte orphelin
      console.error('Erreur écriture Firestore après création Auth, rollback :', firestoreErr);
      try {
        await auth.deleteUser(userRecord.uid);
      } catch (rollbackErr) {
        console.error('Échec du rollback (suppression compte Auth orphelin) :', rollbackErr);
      }
      throw firestoreErr;
    }

  } catch (error) {
    // Rollback : on annule tout ce qui a été créé avant l'échec
    try {
      await auth.deleteUser(userRecord.uid);
    } catch (rollbackErr) {
      console.error('Échec du rollback Auth après erreur Firestore :', rollbackErr);
    }

    try {
      await firestore.collection('pointsDeVente').doc(pdvId).delete();
    } catch (rollbackErr) {
      console.error('Échec du rollback pointsDeVente après erreur Firestore :', rollbackErr);
    }

    console.error('Erreur création PDV (Firestore) :', error);
    return res.status(500).json({ message: 'Erreur serveur, réessayez.' });
  }
});

// ════════════════════════════════
//  RÉCUPÉRER LES PDV D'UNE AGENCE
//  GET /pdv?agenceId=xxx
// ════════════════════════════════
router.get('/', verifierToken, verifierRole('admin'), async (req, res) => {
  const { agenceId } = req.query;

  if (req.user.agenceId !== agenceId) {
    return res.status(403).json({ message: 'Accès refusé à cette agence.' });
  }

  if (!agenceId) {
    return res.status(400).json({ message: 'agenceId manquant.' });
  }

  try {
    const snapshot = await firestore
      .collection('pointsDeVente')
      .where('agenceId', '==', agenceId)
      .orderBy('createdAt', 'desc')
      .get();

    const pdvs = snapshot.docs.map(doc => {
      const d = doc.data();
      delete d.password;
      return d;
    });

    return res.status(200).json({ pdvs });

  } catch (error) {
    console.error('Erreur récupération PDV :', error);
    return res.status(500).json({ message: 'Erreur serveur, réessayez.' });
  }
});

// ════════════════════════════════
//  RÉCUPÉRER UN PDV PAR ID
//  GET /pdv/:pdvId
//  Accessible à l'admin (tous les PDV de son agence) et à l'agent (uniquement le sien)
// ════════════════════════════════
router.get('/:pdvId', verifierToken, async (req, res) => {
  const { pdvId } = req.params;

  try {
    const doc = await firestore.collection('pointsDeVente').doc(pdvId).get();

    if (!doc.exists) {
      return res.status(404).json({ message: 'PDV introuvable.' });
    }

    if (req.user.agenceId !== doc.data().agenceId) {
      return res.status(403).json({ message: 'Accès refusé à ce PDV.' });
    }

    if (req.user.role === 'agent' && req.user.pdvId !== pdvId) {
      return res.status(403).json({ message: 'Accès refusé à ce PDV.' });
    }

    const pdvData = doc.data();
    delete pdvData.password;
    return res.status(200).json(pdvData);

  } catch (error) {
    console.error('Erreur récupération PDV :', error);
    return res.status(500).json({ message: 'Erreur serveur, réessayez.' });
  }
});

// ════════════════════════════════
//  MODIFIER UN PDV
//  PATCH /pdv/:pdvId
// ════════════════════════════════
router.patch('/:pdvId', verifierToken, verifierRole('admin'), async (req, res) => {
  const { pdvId } = req.params;
  const { nom, ville, adresse, responsable, telephone, emailContact, emailConnexion } = req.body;

  try {
    const doc = await firestore.collection('pointsDeVente').doc(pdvId).get();
    if (!doc.exists) return res.status(404).json({ message: 'PDV introuvable.' });

    if (req.user.agenceId !== doc.data().agenceId) {
      return res.status(403).json({ message: 'Accès refusé à ce PDV.' });
    }

    if (!nom || !ville || !adresse || !responsable || !telephone || !emailConnexion) {
      return res.status(400).json({ message: 'Champs obligatoires manquants.' });
    }
    if (typeof nom !== 'string' || nom.trim().length < 2 || nom.length > 100) {
      return res.status(400).json({ message: 'Nom du PDV invalide.' });
    }
    if (typeof ville !== 'string' || ville.trim().length < 2 || ville.length > 100) {
      return res.status(400).json({ message: 'Ville invalide.' });
    }
    if (typeof adresse !== 'string' || adresse.trim().length < 5 || adresse.length > 200) {
      return res.status(400).json({ message: 'Adresse invalide.' });
    }
    if (typeof telephone !== 'string' || !/^\+?[0-9]{6,15}$/.test(telephone.replace(/\s/g, ''))) {
      return res.status(400).json({ message: 'Numéro de téléphone invalide.' });
    }
    if (typeof responsable !== 'string' || responsable.trim().length < 2 || responsable.length > 100) {
      return res.status(400).json({ message: 'Nom du responsable invalide.' });
    }
    if (typeof emailConnexion !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailConnexion)) {
      return res.status(400).json({ message: 'Email de connexion invalide.' });
    }
    if (emailContact !== undefined && emailContact !== null && emailContact !== '' && (typeof emailContact !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailContact))) {
      return res.status(400).json({ message: 'Email de contact invalide.' });
    }

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
router.patch('/:pdvId/statut', verifierToken, verifierRole('admin'), async (req, res) => {
  const { pdvId }  = req.params;
  const { actif }  = req.body;

  try {
    const docCheck = await firestore.collection('pointsDeVente').doc(pdvId).get();
    if (!docCheck.exists) return res.status(404).json({ message: 'PDV introuvable.' });

    if (req.user.agenceId !== docCheck.data().agenceId) {
      return res.status(403).json({ message: 'Accès refusé à ce PDV.' });
    }

    if (typeof actif !== 'boolean') {
      return res.status(400).json({ message: 'Le champ actif doit être true ou false.' });
    }

    if (!(await essaiEstActif(docCheck.data().agenceId))) {
      return res.status(403).json({ message: "Période d'essai expirée.", code: 'ESSAI_EXPIRE' });
    }

    const actifPrecedent = docCheck.data().actif;
    const agentUid       = docCheck.data().agentUid;

    await firestore.collection('pointsDeVente').doc(pdvId).update({ actif });

    if (agentUid) {
      try {
        await auth.updateUser(agentUid, { disabled: !actif });
      } catch (authErr) {
        // L'update Auth a échoué — on revient en arrière côté Firestore pour rester cohérent
        console.error('Erreur update Auth statut agent, rollback Firestore :', authErr);
        await firestore.collection('pointsDeVente').doc(pdvId).update({ actif: actifPrecedent }).catch(rollbackErr => {
          console.error('Échec du rollback statut PDV :', rollbackErr);
        });
        return res.status(500).json({ message: "Erreur lors de la mise à jour du compte agent, réessayez." });
      }
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
//  RÉVÉLER LE MOT DE PASSE D'UN PDV
//  POST /pdv/:pdvId/reveal-password
// ════════════════════════════════
router.post('/:pdvId/reveal-password', verifierToken, verifierRole('admin'), revealPasswordLimiter, async (req, res) => {
  const { pdvId } = req.params;

  try {
    const doc = await firestore.collection('pointsDeVente').doc(pdvId).get();
    if (!doc.exists) {
      return res.status(404).json({ message: 'PDV introuvable.' });
    }

    const pdvData = doc.data();

    if (req.user.agenceId !== pdvData.agenceId) {
      return res.status(403).json({ message: 'Accès refusé à ce PDV.' });
    }

    await firestore.collection('auditLogs').add({
      type:      'reveal_pdv_password',
      pdvId,
      pdvNom:    pdvData.nom || null,
      adminUid:  req.user.uid,
      agenceId:  req.user.agenceId,
      timestamp: new Date().toISOString(),
    });

    const password = pdvData.password ? decrypt(pdvData.password) : null;

    return res.status(200).json({ password });

  } catch (error) {
    console.error('Erreur reveal password PDV :', error);
    return res.status(500).json({ message: 'Erreur serveur, réessayez.' });
  }
});

// ════════════════════════════════
//  RÉINITIALISER LE MOT DE PASSE AGENT
//  PATCH /pdv/:pdvId/reset-password
// ════════════════════════════════
router.patch('/:pdvId/reset-password', verifierToken, verifierRole('admin'), async (req, res) => {
  const { pdvId }       = req.params;
  const { newPassword } = req.body;

  try {
    const doc = await firestore.collection('pointsDeVente').doc(pdvId).get();

    if (!doc.exists) {
      return res.status(404).json({ message: 'PDV introuvable.' });
    }

    if (req.user.agenceId !== doc.data().agenceId) {
      return res.status(403).json({ message: 'Accès refusé à ce PDV.' });
    }

    if (typeof newPassword !== 'string' || newPassword.length < 6) {
      return res.status(400).json({ message: 'Mot de passe trop court (min. 6 caractères).' });
    }

    const { agentUid } = doc.data();

    if (!(await essaiEstActif(doc.data().agenceId))) {
      return res.status(403).json({ message: "Période d'essai expirée.", code: 'ESSAI_EXPIRE' });
    }

    if (!agentUid) {
      return res.status(400).json({ message: 'Aucun agent associé à ce PDV.' });
    }

    await auth.updateUser(agentUid, { password: newPassword });

    await firestore.collection('pointsDeVente').doc(pdvId).update({
      password: encrypt(newPassword),
      updatedAt: new Date().toISOString(),
    });

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
router.patch('/:pdvId/quota', verifierToken, verifierRole('admin'), async (req, res) => {
  const { pdvId } = req.params;
  const { quota } = req.body;

  try {
    const docCheck = await firestore.collection('pointsDeVente').doc(pdvId).get();
    if (!docCheck.exists) return res.status(404).json({ message: 'PDV introuvable.' });

    if (req.user.agenceId !== docCheck.data().agenceId) {
      return res.status(403).json({ message: 'Accès refusé à ce PDV.' });
    }

    if (typeof quota !== 'number' || !Number.isFinite(quota) || quota < 0) {
      return res.status(400).json({ message: 'Quota invalide.' });
    }

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
router.delete('/:pdvId', verifierToken, verifierRole('admin'), async (req, res) => {
  const { pdvId } = req.params;

  try {
    const doc = await firestore.collection('pointsDeVente').doc(pdvId).get();

    if (!doc.exists) {
      return res.status(404).json({ message: 'PDV introuvable.' });
    }

    if (req.user.agenceId !== doc.data().agenceId) {
      return res.status(403).json({ message: 'Accès refusé à ce PDV.' });
    }

    const { agentUid } = doc.data();

    if (!(await essaiEstActif(doc.data().agenceId))) {
      return res.status(403).json({ message: "Période d'essai expirée.", code: 'ESSAI_EXPIRE' });
    }

    // Étape 1 : suppression atomique des documents Firestore (users + pointsDeVente)
    const batch = firestore.batch();
    if (agentUid) {
      batch.delete(firestore.collection('users').doc(agentUid));
    }
    batch.delete(firestore.collection('pointsDeVente').doc(pdvId));

    await batch.commit();

    // Étape 2 : suppression du compte Auth, en dernier.
    if (agentUid) {
      const MAX_TENTATIVES = 3;
      let derniereErreur = null;

      for (let tentative = 1; tentative <= MAX_TENTATIVES; tentative++) {
        try {
          await auth.deleteUser(agentUid);
          derniereErreur = null;
          break;
        } catch (authErr) {
          if (authErr.code === 'auth/user-not-found') {
            derniereErreur = null;
            break;
          }
          derniereErreur = authErr;
          if (tentative < MAX_TENTATIVES) {
            await new Promise(r => setTimeout(r, 500 * tentative));
          }
        }
      }

      if (derniereErreur) {
        console.error(
          `Compte Auth ${agentUid} non supprimé après ${MAX_TENTATIVES} tentatives (nettoyage manuel requis) :`,
          derniereErreur.message
        );
      }
    };

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
router.get('/:pdvId/trajets', verifierToken, async (req, res) => {
  const { pdvId } = req.params;
  const { agenceId } = req.query;

  if (req.user.agenceId !== agenceId) {
    return res.status(403).json({ message: 'Accès refusé à cette agence.' });
  }

  if (req.user.role === 'agent' && req.user.pdvId !== pdvId) {
    return res.status(403).json({ message: 'Accès refusé à ce PDV.' });
  }

  if (!agenceId) return res.status(400).json({ message: 'agenceId manquant.' });

 try {
    const pdvDoc = await firestore.collection('pointsDeVente').doc(pdvId).get();
    if (!pdvDoc.exists) return res.status(404).json({ message: 'PDV introuvable.' });
    if (pdvDoc.data().agenceId !== req.user.agenceId) {
      return res.status(403).json({ message: 'Accès refusé à ce PDV.' });
    }

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
router.get('/:pdvId/places-dispo', verifierToken, async (req, res) => {
  const { pdvId } = req.params;
  const { agenceId, date } = req.query;

  if (req.user.agenceId !== agenceId) {
    return res.status(403).json({ message: 'Accès refusé à cette agence.' });
  }

  if (req.user.role === 'agent' && req.user.pdvId !== pdvId) {
    return res.status(403).json({ message: 'Accès refusé à ce PDV.' });
  }

  if (!agenceId || !date) {
    return res.status(400).json({ message: 'agenceId et date obligatoires.' });
  }

  try {
    const pdvDoc = await firestore.collection('pointsDeVente').doc(pdvId).get();
    if (!pdvDoc.exists) return res.status(404).json({ message: 'PDV introuvable.' });
    if (pdvDoc.data().agenceId !== req.user.agenceId) {
      return res.status(403).json({ message: 'Accès refusé à ce PDV.' });
    }

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
//  Accessible à l'admin (tous les PDV de son agence) et à l'agent (uniquement le sien)
// ════════════════════════════════
router.get('/:pdvId/stats', verifierToken, async (req, res) => {
  const { pdvId }    = req.params;
  const { agenceId, dateDebut, dateFin, trajetId } = req.query;

  if (req.user.agenceId !== agenceId) {
    return res.status(403).json({ message: 'Accès refusé à cette agence.' });
  }

  if (req.user.role === 'agent' && req.user.pdvId !== pdvId) {
    return res.status(403).json({ message: 'Accès refusé à ce PDV.' });
  }

  if (!agenceId) return res.status(400).json({ message: 'agenceId manquant.' });

  try {
    const pdvDoc = await firestore.collection('pointsDeVente').doc(pdvId).get();
    if (!pdvDoc.exists) return res.status(404).json({ message: 'PDV introuvable.' });
    if (pdvDoc.data().agenceId !== req.user.agenceId) {
      return res.status(403).json({ message: 'Accès refusé à ce PDV.' });
    }

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