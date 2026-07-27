const { auth, firestore } = require('../firebase');

// Email exempté de la limite d'essai
const EMAIL_EXEMPTE = 'precieuxjusticek@gmail.com';

// Vérifie si l'agence appartient au compte exempté (via son uid)
async function estAgenceExemptee(agenceUid) {
  if (!agenceUid) return false;
  try {
    const user = await auth.getUserByEmail(EMAIL_EXEMPTE);
    return user.uid === agenceUid;
  } catch {
    return false;
  }
}

// ── Système d'essai gratuit Travio ──
const DUREE_ESSAI_JOURS = 12;
const PDV_INCLUS        = 6;   // conservé si utilisé ailleurs (routes/pdv.js par ex.)

// Calcule la date de fin d'essai à partir d'une date de début (par défaut : maintenant)
function calculerDateFinEssai(dateDebut = new Date()) {
  const fin = new Date(dateDebut);
  fin.setDate(fin.getDate() + DUREE_ESSAI_JOURS);
  return fin;
}

// Vérifie si l'essai d'une agence est actif (utilisable hors requête HTTP, ex: cron)
async function essaiEstActif(agenceId) {
  if (!agenceId) return false;
  try {
    const doc = await firestore.collection('agences').doc(agenceId).get();
    if (!doc.exists) return false;

    const data = doc.data();
    if (await estAgenceExemptee(data.adminUid)) return true;

    const essai = data.essai;
    if (!essai || !essai.actif) return false;

    if (essai.dateFin && new Date(essai.dateFin) < new Date()) {
      await firestore.collection('agences').doc(agenceId).update({ 'essai.actif': false });
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

// Middleware — bloque les routes si l'essai de l'agence n'est plus actif
const checkEssai = async (req, res, next) => {
  const agenceId = req.user?.agenceId;
  if (!agenceId) {
    return res.status(400).json({ message: 'agenceId manquant.', code: 'AGENCE_ID_MANQUANT' });
  }
  try {
    const doc = await firestore.collection('agences').doc(agenceId).get();
    if (!doc.exists) return res.status(404).json({ message: 'Agence introuvable.' });

    const data = doc.data();
    if (await estAgenceExemptee(data.adminUid)) return next();

    const essai = data.essai;
    if (!essai) {
      return res.status(403).json({ message: "Aucune période d'essai trouvée.", code: 'ESSAI_INTROUVABLE' });
    }
    if (!essai.actif) {
      return res.status(403).json({ message: "Période d'essai expirée.", code: 'ESSAI_EXPIRE' });
    }
    if (essai.dateFin && new Date(essai.dateFin) < new Date()) {
      await firestore.collection('agences').doc(agenceId).update({ 'essai.actif': false });
      return res.status(403).json({ message: "Période d'essai expirée.", code: 'ESSAI_EXPIRE' });
    }
    next();
  } catch (err) {
    return res.status(500).json({ message: "Erreur vérification de l'essai." });
  }
};

module.exports = {
  DUREE_ESSAI_JOURS,
  PDV_INCLUS,
  calculerDateFinEssai,
  checkEssai,
  estAgenceExemptee,
  essaiEstActif,   // ← ajouté
};