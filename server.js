const express  = require('express');
const cors     = require('cors');
require('dotenv').config();

const { auth, firestore } = require('./firebase');
const { cloudinary, uploadToCloudinary } = require('./config/cloudinary');
const { OFFSET_BRAZZA_MS, todayBrazza } = require('./helpers/dates');
const { getSegmentsTrajet } = require('./helpers/segments');
const { estAgenceExemptee, essaiEstActif } = require('./helpers/essai');
const { verifierToken } = require('./middlewares/verifierToken');
const { sanitizeInput } = require('./helpers/sanitize');
const { limiterGlobal, limiterAuth } = require('./middlewares/rateLimiter');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);

// ── Middlewares ──
const allowedOrigins = [
  'https://travio-vtk.netlify.app',
  'http://127.0.0.1:5501',
  'http://localhost:5501',
];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Non autorisé par CORS'));
    }
  },
  credentials: true,
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json({ limit: '20mb' }));
app.use(sanitizeInput);
app.use(limiterGlobal);

// ════════════════════════════════
//  HEALTH CHECK
// ════════════════════════════════
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', time: new Date().toISOString() });
});
app.use('/auth', limiterAuth, require('./routes/auth'));
app.use('/agence', require('./routes/agence'));
app.use('/pdv', require('./routes/pdv'));
app.use('/trajet', require('./routes/trajets'));
app.use('/', require('./routes/departs'));
app.use('/', require('./routes/sessions'));
app.use('/reservations', require('./routes/reservations'));
app.use('/colis', require('./routes/colis'));
app.use('/support', require('./routes/support'));
app.use('/vehicule', require('./routes/vehicules'));
app.use('/admin', require('./routes/admin'));

// ════════════════════════════════
//  RÉCUPÉRER LES TRAJETS
//  GET /trajets?agenceId=xxx
// ════════════════════════════════
app.get('/trajets', verifierToken, async (req, res) => {
  const agenceId = req.user.agenceId;

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
//  CRON JOB — Génération automatique des sessions
//  Chaque nuit à minuit (heure Brazzaville)
// ════════════════════════════════
const cron = require('node-cron');

cron.schedule('0 23 * * *', async () => {
  console.log('🔄 Cron : génération automatique des sessions...');

  try {
    // Récupérer tous les départs actifs
    const departsSnap = await firestore
      .collection('departs')
      .where('actif', '==', true)
      .get();

    const departs = departsSnap.docs.map(d => d.data());
    let total = 0;

    for (const depart of departs) {
      // On saute les départs dont l'agence a un essai expiré
      const actif = await essaiEstActif(depart.agenceId);
      if (!actif) continue;

      // Appeler la logique existante de génération
      const res = await fetch(`http://localhost:${PORT}/depart/${depart.id}/generer-sessions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-internal-key': process.env.INTERNAL_CRON_KEY,
        },
        body: JSON.stringify({ nbJours: 14 }),
      });
      const data = await res.json();
      total += data.sessions?.length || 0;
    }

    console.log(`✅ Cron terminé : ${total} session(s) générée(s).`);

  } catch (err) {
    console.error('❌ Erreur cron génération sessions :', err);
  }
}, {
  timezone: 'Africa/Brazzaville'
});

// ════════════════════════════════
//  CRON JOB — Correction automatique des essais expirés (12 jours)
//  Chaque nuit à minuit (heure Brazzaville)
// ════════════════════════════════
cron.schedule('0 0 * * *', async () => {
  console.log('🔄 Cron : vérification des essais expirés...');

  try {
    const snapshot = await firestore
      .collection('agences')
      .where('essai.actif', '==', true)
      .get();

    const maintenant = new Date();
    let nbExpires = 0;

    for (const doc of snapshot.docs) {
      const agence = doc.data();
      if (await estAgenceExemptee(agence.adminUid)) continue;

      const fin = agence.essai?.dateFin;
      if (fin && new Date(fin) < maintenant) {
        await doc.ref.update({ 'essai.actif': false });
        nbExpires++;
      }
    }

    console.log(`✅ Cron terminé : ${nbExpires} essai(s) marqué(s) expiré(s).`);

  } catch (err) {
    console.error('❌ Erreur cron vérification essais :', err);
  }
}, {
  timezone: 'Africa/Brazzaville'
});

// ════════════════════════════════
//  CRON JOB — Auto-ping (garde le service éveillé sur Render)
//  Toutes les 10 minutes
// ════════════════════════════════
const PUBLIC_URL = 'https://travio-backend-pa4q.onrender.com';

cron.schedule('*/10 * * * *', async () => {
  try {
    await fetch(`${PUBLIC_URL}/health`);
    console.log('🏓 Auto-ping OK — service maintenu éveillé');
  } catch (err) {
    console.error('❌ Erreur auto-ping :', err.message);
  }
});

// ── Démarrage du serveur ──
app.listen(PORT, () => {
  console.log(`Serveur TRAVIO démarré sur http://localhost:${PORT}`);
});