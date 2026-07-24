const express = require('express');
const router  = express.Router();

const { firestore } = require('../firebase');

// ════════════════════════════════
//  SUPPORT — RECEVOIR UN MESSAGE
//  POST /support/create
// ════════════════════════════════
router.post('/create', async (req, res) => {
  const { type, sujet, message, email, agenceId } = req.body;

  if (!type || !sujet || !message) {
    return res.status(400).json({ message: 'Champs obligatoires manquants.' });
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