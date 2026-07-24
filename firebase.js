const admin = require('firebase-admin');
require('dotenv').config();

const serviceAccount = JSON.parse(
  process.env.FIREBASE_KEY.replace(/\\n/g, '\n')
);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const auth = admin.auth();
const firestore = admin.firestore();

module.exports = { auth, firestore };