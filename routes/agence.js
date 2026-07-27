const express = require('express');
const router  = express.Router();

const { firestore } = require('../firebase');
const { cloudinary, uploadToCloudinary } = require('../config/cloudinary');
const { calculerDateFinEssai, estAgenceExemptee } = require('../helpers/essai');
const { verifierToken } = require('../middlewares/verifierToken');
const { verifierRole } = require('../middlewares/verifierRole');

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
//  CRÉER UNE AGENCE
//  POST /agence/create
// ════════════════════════════════
router.post('/create', verifierToken, async (req, res) => {
  const uid = req.user.uid;
  const {
    nom, ville, pays, adresse, telephone,
    slogan, description, histoire, anneeCreation,
    point1, point2, point3, engagements,
    logoBase64, photosBase64, regles, politiqueAnnulation,
    delaiFormalite,
  } = req.body;

  if (!uid || !nom || !ville || !adresse || !telephone || !slogan || !description) {
    return res.status(400).json({ message: 'Champs obligatoires manquants.' });
  }

  if (photosBase64 && photosBase64.length > 5) {
    return res.status(400).json({ message: 'Maximum 5 photos autorisées.' });
  }

  try {
    let logoUrl = null;
    if (logoBase64) {
      logoUrl = await uploadToCloudinary(logoBase64, `travio/agences/${uid}`, 'logo');
    }

    const photosUrls = [];
    if (photosBase64 && photosBase64.length > 0) {
      for (let i = 0; i < photosBase64.length; i++) {
        const url = await uploadToCloudinary(
          photosBase64[i],
          `travio/agences/${uid}/photos`,
          `photo_${i + 1}`
        );
        photosUrls.push(url);
      }
    }

    const agenceRef = firestore.collection('agences').doc();
    const agenceId  = agenceRef.id;

    const agenceData = {
      id:            agenceId,
      adminUid:      uid,
      nom,
      ville,
      pays:          pays || 'Congo Brazzaville',
      adresse,
      telephone,
      slogan,
      description,
      histoire:      histoire      || null,
      anneeCreation: anneeCreation || null,
      point1:        point1        || null,
      point2:        point2        || null,
      point3:        point3        || null,
      engagements:   engagements   || null,
      regles:        regles         || null,
      politiqueAnnulation: politiqueAnnulation || null,
      delaiFormalite: delaiFormalite || null,
      logoUrl,
      photos:        photosUrls,
      actif:         true,
      essai: {
        dateDebut: new Date().toISOString(),
        dateFin:   calculerDateFinEssai().toISOString(),
        actif:     true,
      },
      createdAt:     new Date().toISOString(),
    };

    await agenceRef.set(agenceData);

    await firestore.collection('users').doc(uid).update({ agenceId });

    return res.status(201).json({
      message: 'Agence créée avec succès.',
      agence:  agenceData,
    });

  } catch (err) {
    console.error('Erreur création agence :', err);
    return res.status(500).json({ message: 'Erreur serveur, réessayez.' });
  }
});

// ════════════════════════════════
//  RÉCUPÉRER UNE AGENCE
//  GET /agence/:agenceId
// ════════════════════════════════
router.get('/:agenceId', verifierToken, async (req, res) => {
  const { agenceId } = req.params;

  if (req.user.agenceId !== agenceId) {
    return res.status(403).json({ message: 'Accès refusé à cette agence.' });
  }

  if (!agenceId) {
    return res.status(400).json({ message: 'agenceId manquant.' });
  }

  try {
    const doc = await firestore.collection('agences').doc(agenceId).get();

    if (!doc.exists) {
      return res.status(404).json({ message: 'Agence introuvable.' });
    }

    const data = doc.data();
    data.exempte = await estAgenceExemptee(data.adminUid);
    return res.status(200).json(data);

  } catch (err) {
    console.error('Erreur récupération agence :', err);
    return res.status(500).json({ message: 'Erreur serveur, réessayez.' });
  }
});

// ════════════════════════════════
//  MODIFIER UNE AGENCE
//  PATCH /agence/:agenceId
// ════════════════════════════════
router.patch('/:agenceId', verifierToken, verifierRole('admin'), async (req, res) => {
  const { agenceId } = req.params;

  if (req.user.agenceId !== agenceId) {
    return res.status(403).json({ message: 'Accès refusé à cette agence.' });
  }

  const {
    nom, slogan, description, histoire, ville, adresse,
    telephone, anneeCreation, point1, point2, point3,
    engagements, regles, politiqueAnnulation, delaiFormalite,
  } = req.body;

  if (!nom || !slogan || !description || !ville || !adresse || !telephone) {
    return res.status(400).json({ message: 'Champs obligatoires manquants.' });
  }

  try {
    const updateData = {
      nom, slogan, description, ville, adresse, telephone,
      histoire:      histoire      || null,
      anneeCreation: anneeCreation || null,
      point1:        point1        || null,
      point2:        point2        || null,
      point3:        point3        || null,
      engagements:   engagements   || null,
      regles:        regles        || null,
      politiqueAnnulation: politiqueAnnulation || null,
      delaiFormalite: delaiFormalite || null,
      updatedAt:     new Date().toISOString(),
    };

    await firestore.collection('agences').doc(agenceId).update(updateData);

    return res.status(200).json({ message: 'Agence mise à jour.', agence: updateData });

  } catch (err) {
    console.error('Erreur update agence :', err);
    return res.status(500).json({ message: 'Erreur serveur, réessayez.' });
  }
});

// ════════════════════════════════
//  MODIFIER LES IMAGES D'UNE AGENCE
//  PATCH /agence/:agenceId/images
// ════════════════════════════════
router.patch('/:agenceId/images', verifierToken, verifierRole('admin'), async (req, res) => {
  const { agenceId } = req.params;

  if (req.user.agenceId !== agenceId) {
    return res.status(403).json({ message: 'Accès refusé à cette agence.' });
  }

  const { logoBase64, photosToAdd, photosToDelete } = req.body;

  try {
    const doc = await firestore.collection('agences').doc(agenceId).get();
    if (!doc.exists) return res.status(404).json({ message: 'Agence introuvable.' });

    const agence = doc.data();
    const uid    = agence.adminUid;
    let updateData = {};

    if (logoBase64) {
      const logoUrl = await uploadToCloudinary(logoBase64, `travio/agences/${uid}`, 'logo');
      updateData.logoUrl = logoUrl;
    }

    let currentPhotos = agence.photos || [];
    if (photosToDelete && photosToDelete.length > 0) {
      for (const url of photosToDelete) {
        const match = url.match(/upload\/(?:v\d+\/)?(.+)\.\w+$/);
        if (match) {
          try {
            await cloudinary.uploader.destroy(match[1]);
          } catch (e) {
            console.warn('Suppression Cloudinary échouée pour :', url, e.message);
          }
        }
      }
      currentPhotos = currentPhotos.filter(p => !photosToDelete.includes(p));
    }

    if (photosToAdd && photosToAdd.length > 0) {
      const total = currentPhotos.length + photosToAdd.length;
      if (total > 5) {
        return res.status(400).json({ message: `Maximum 5 photos. Vous en avez déjà ${currentPhotos.length}.` });
      }
      for (let i = 0; i < photosToAdd.length; i++) {
        const index = currentPhotos.length + i + 1;
        const url = await uploadToCloudinary(
          photosToAdd[i],
          `travio/agences/${uid}/photos`,
          `photo_${Date.now()}_${index}`
        );
        currentPhotos.push(url);
      }
    }

    updateData.photos    = currentPhotos;
    updateData.updatedAt = new Date().toISOString();

    await firestore.collection('agences').doc(agenceId).update(updateData);

    return res.status(200).json({
      message:  'Images mises à jour.',
      logoUrl:  updateData.logoUrl || agence.logoUrl,
      photos:   currentPhotos,
    });

  } catch (err) {
    console.error('Erreur update images agence :', err);
    return res.status(500).json({ message: 'Erreur serveur, réessayez.' });
  }
});

// ════════════════════════════════
//  TYPES DE BILLETS
//  PATCH /agence/:agenceId/types-billet
// ════════════════════════════════
router.patch('/:agenceId/types-billet', verifierToken, verifierRole('admin'), async (req, res) => {
  const { agenceId } = req.params;

  if (req.user.agenceId !== agenceId) {
    return res.status(403).json({ message: 'Accès refusé à cette agence.' });
  }

  const { typesBillet } = req.body;

  if (!Array.isArray(typesBillet) || typesBillet.length === 0) {
    return res.status(400).json({ message: 'Liste de types de billets invalide.' });
  }
  for (const t of typesBillet) {
    if (!t.id || !t.nom || typeof t.ageMin !== 'number') {
      return res.status(400).json({ message: 'Chaque type doit avoir un id, un nom et un âge min.' });
    }
  }

  try {
    const agenceDoc = await firestore.collection('agences').doc(agenceId).get();
    if (!agenceDoc.exists) return res.status(404).json({ message: 'Agence introuvable.' });

    const ancienTypes = agenceDoc.data().typesBillet || [];
    const anciensIds   = ancienTypes.map(t => t.id);
    const nouveauxIds  = typesBillet.map(t => t.id);

    const typesAjoutes  = nouveauxIds.filter(id => !anciensIds.includes(id));
    const typesRetires  = anciensIds.filter(id => !nouveauxIds.includes(id));

    await firestore.collection('agences').doc(agenceId).update({
      typesBillet,
      updatedAt: new Date().toISOString(),
    });

    let trajetsImpactes = 0;
    if (typesAjoutes.length > 0 || typesRetires.length > 0) {
      const trajetsSnap = await firestore.collection('trajets')
        .where('agenceId', '==', agenceId)
        .get();

      const batch = creerBatchAutoCommit(firestore);

      for (const doc of trajetsSnap.docs) {
        const trajet = doc.data();
        let modifie = false;

        const nouveauPrixParType = { ...(trajet.prixParType || {}) };

        typesAjoutes.forEach(id => {
          if (!(id in nouveauPrixParType)) {
            nouveauPrixParType[id] = 0;
            modifie = true;
          }
        });

        typesRetires.forEach(id => {
          if (id in nouveauPrixParType) {
            delete nouveauPrixParType[id];
            modifie = true;
          }
        });

        let nouveauxArrets = trajet.arrets;
        if (Array.isArray(trajet.arrets) && trajet.arrets.length > 0) {
          nouveauxArrets = trajet.arrets.map(a => {
            const prixArret = { ...(a.prixParType || {}) };
            let arretModifie = false;
            typesAjoutes.forEach(id => {
              if (!(id in prixArret)) { prixArret[id] = 0; arretModifie = true; }
            });
            typesRetires.forEach(id => {
              if (id in prixArret) { delete prixArret[id]; arretModifie = true; }
            });
            if (arretModifie) modifie = true;
            return arretModifie ? { ...a, prixParType: prixArret } : a;
          });
        }

        let nouveauxTroncons = trajet.prixTroncons;
        if (trajet.prixTroncons && Object.keys(trajet.prixTroncons).length > 0) {
          nouveauxTroncons = {};
          let tronconModifie = false;
          Object.entries(trajet.prixTroncons).forEach(([cle, prixParTypeTroncon]) => {
            const copie = { ...prixParTypeTroncon };
            typesAjoutes.forEach(id => {
              if (!(id in copie)) { copie[id] = 0; tronconModifie = true; }
            });
            typesRetires.forEach(id => {
              if (id in copie) { delete copie[id]; tronconModifie = true; }
            });
            nouveauxTroncons[cle] = copie;
          });
          if (tronconModifie) modifie = true;
        }

        if (modifie) {
          await batch.update(doc.ref, {
            prixParType: nouveauPrixParType,
            ...(nouveauxArrets   !== trajet.arrets        && { arrets: nouveauxArrets }),
            ...(nouveauxTroncons !== trajet.prixTroncons  && { prixTroncons: nouveauxTroncons }),
            updatedAt: new Date().toISOString(),
          });
          trajetsImpactes++;
        }
      }

      if (trajetsImpactes > 0) await batch.commitFinal();
    }

    return res.status(200).json({
      message: 'Types de billets mis à jour.',
      typesBillet,
      trajetsImpactes,
      typesAjoutes,
      typesRetires,
    });

  } catch (err) {
    console.error('Erreur update types billet :', err);
    return res.status(500).json({ message: 'Erreur serveur.' });
  }
});

// ════════════════════════════════
//  CONFIGURATION DES BILLETS
//  PATCH /agence/:agenceId/billet-config
// ════════════════════════════════
router.patch('/:agenceId/billet-config', verifierToken, verifierRole('admin'), async (req, res) => {
  const { agenceId } = req.params;

  if (req.user.agenceId !== agenceId) {
    return res.status(403).json({ message: 'Accès refusé à cette agence.' });
  }

  const { billetMode, billetDesign } = req.body;

  const modesValides = ['machine_a4a5', 'machine_thermique', 'manuel'];
  if (!modesValides.includes(billetMode)) {
    return res.status(400).json({ message: 'Mode d\'impression invalide.' });
  }

  const designRequis = billetMode === 'machine_a4a5' || billetMode === 'machine_thermique';
  if (designRequis && !['sobre', 'colore'].includes(billetDesign)) {
    return res.status(400).json({ message: 'Design invalide pour ce mode.' });
  }

  try {
    const updateData = {
      billetConfig: {
        mode: billetMode,
        design: designRequis ? billetDesign : null,
        configuredAt: new Date().toISOString(),
      },
    };

    await firestore.collection('agences').doc(agenceId).update(updateData);

    return res.status(200).json({
      message: 'Configuration des billets enregistrée.',
      billetConfig: updateData.billetConfig,
    });

  } catch (err) {
    console.error('Erreur update billet-config :', err);
    return res.status(500).json({ message: 'Erreur serveur.' });
  }
});

module.exports = router;