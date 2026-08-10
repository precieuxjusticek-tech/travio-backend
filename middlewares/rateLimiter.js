const rateLimit = require('express-rate-limit');

// Limite générale — toutes les routes de l'API
const limiterGlobal = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 300,                 // 300 requêtes / IP / fenêtre
  standardHeaders: true,    // renvoie RateLimit-* dans les headers
  legacyHeaders: false,
  message: { message: 'Trop de requêtes, réessayez plus tard.' },
});

// Limite stricte — routes sensibles (auth : login, reset password, etc.)
const limiterAuth = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,                  // 10 tentatives / IP / fenêtre
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Trop de tentatives, réessayez dans 15 minutes.' },
});

module.exports = { limiterGlobal, limiterAuth };