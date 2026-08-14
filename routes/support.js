const express = require('express');
const router  = express.Router();

const { firestore } = require('../firebase');
const rateLimit = require('express-rate-limit');

const supportLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { message: 'Trop de messages envoyés, réessayez plus tard.' },
});

// ════════════════════════════════
//  SUPPORT — RECEVOIR UN MESSAGE
//  POST /support/create
// ════════════════════════════════
router.post('/create', supportLimiter, async (req, res) => {
  const { type, sujet, message, email, agenceId } = req.body;

  if (!type || !sujet || !message) {
    return res.status(400).json({ message: 'Champs obligatoires manquants.' });
  }
  const typesValides = ['bug', 'question', 'suggestion', 'autre'];
  if (typeof type !== 'string' || !typesValides.includes(type)) {
    return res.status(400).json({ message: 'Type invalide.' });
  }
  if (typeof sujet !== 'string' || sujet.trim().length < 3 || sujet.length > 150) {
    return res.status(400).json({ message: 'Sujet invalide (3 à 150 caractères).' });
  }
  if (typeof message !== 'string' || message.trim().length < 5 || message.length > 3000) {
    return res.status(400).json({ message: 'Message invalide (5 à 3000 caractères).' });
  }
  if (email !== undefined && email !== null && email !== '' && (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
    return res.status(400).json({ message: 'Email invalide.' });
  }
  if (agenceId !== undefined && agenceId !== null && typeof agenceId !== 'string') {
    return res.status(400).json({ message: 'agenceId invalide.' });
  }

  try {
    const ref = firestore.collection('support_messages').doc();
    await ref.set({
      id:        ref.id,
      type,
      sujet,
      message,
      email:     email    || null,
      agenceId:  agenceId || null,
      statut:    'nouveau',
      createdAt: new Date().toISOString(),
    });

    return res.status(201).json({ message: 'Message reçu.' });

  } catch (err) {
    console.error('Erreur support :', err);
    return res.status(500).json({ message: 'Erreur serveur.' });
  }
});

module.exports = router;