const admin = require('firebase-admin');
const path  = require('path');
require('dotenv').config();

// Initialisation Firebase Admin avec la clé privée
const serviceAccount = require(path.resolve(process.env.FIREBASE_KEY_PATH));

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// On exporte auth et firestore pour les utiliser dans server.js
const auth      = admin.auth();
const firestore = admin.firestore();

module.exports = { auth, firestore };