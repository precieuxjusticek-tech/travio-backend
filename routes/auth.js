const express = require('express');
const router  = express.Router();

const { auth, firestore } = require('../firebase');
const { verifierToken }   = require('../middlewares/verifierToken');

// ════════════════════════════════
//  INSCRIPTION
//  POST /auth/register
//  Body : { prenom, nom, email, password }
// ════════════════════════════════
router.post('/register', async (req, res) => {
  const { prenom, nom, email, password } = req.body;

  if (!prenom || !nom || !email || !password) {
    return res.status(400).json({ message: 'Tous les champs sont obligatoires.' });
  }
  if (typeof prenom !== 'string' || prenom.trim().length < 2 || prenom.length > 50) {
    return res.status(400).json({ message: 'Prénom invalide (2 à 50 caractères).' });
  }
  if (typeof nom !== 'string' || nom.trim().length < 2 || nom.length > 50) {
    return res.status(400).json({ message: 'Nom invalide (2 à 50 caractères).' });
  }
  if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ message: 'Email invalide.' });
  }
  if (typeof password !== 'string' || password.length < 6) {
    return res.status(400).json({ message: 'Le mot de passe doit faire au moins 6 caractères.' });
  }

  try {
    const userRecord = await auth.createUser({
      email,
      password,
      displayName: `${prenom} ${nom}`,
    });

    await firestore.collection('users').doc(userRecord.uid).set({
      prenom,
      nom,
      email,
      role: 'admin',
      agenceId: null,
      createdAt: new Date().toISOString(),
    });

    return res.status(201).json({
      message: 'Compte créé avec succès.',
      uid: userRecord.uid,
    });

  } catch (error) {
    if (error.code === 'auth/email-already-exists') {
      return res.status(409).json({ message: 'Cet email est déjà utilisé.' });
    }
    if (error.code === 'auth/weak-password') {
      return res.status(400).json({ message: 'Le mot de passe doit faire au moins 6 caractères.' });
    }
    console.error('Erreur inscription :', error);
    return res.status(500).json({ message: 'Erreur serveur, réessayez.' });
  }
});

// ════════════════════════════════
//  CONNEXION
//  POST /auth/login
// ════════════════════════════════
router.post('/login', verifierToken, async (req, res) => {
  try {
    // req.user vient du token vérifié (uid, email, role, agenceId, pdvId)
    // On va chercher prenom/nom qui ne sont pas dans req.user
    const userDoc = await firestore.collection('users').doc(req.user.uid).get();

    if (!userDoc.exists) {
      return res.status(404).json({ message: 'Utilisateur introuvable.' });
    }

    const userData = userDoc.data();

    return res.status(200).json({
      message:  'Connexion réussie.',
      uid:      req.user.uid,
      prenom:   userData.prenom,
      nom:      userData.nom,
      role:     userData.role,
      agenceId: userData.agenceId,
      pdvId:    userData.pdvId || null,
    });

  } catch (error) {
    console.error('Erreur connexion :', error);
    return res.status(500).json({ message: 'Erreur serveur, réessayez.' });
  }
});

// ════════════════════════════════
//  MOT DE PASSE OUBLIÉ
//  POST /auth/forgot-password
// ════════════════════════════════
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;

  if (!email || typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ message: 'Email invalide.' });
  }

  try {
    await auth.getUserByEmail(email);

    return res.status(200).json({
      message: 'Si cet email existe, un lien vous sera envoyé.',
    });

  } catch (error) {
    if (error.code === 'auth/user-not-found') {
      return res.status(200).json({
        message: 'Si cet email existe, un lien vous sera envoyé.',
      });
    }
    console.error('Erreur forgot password :', error);
    return res.status(500).json({ message: 'Erreur serveur, réessayez.' });
  }
});

module.exports = router;