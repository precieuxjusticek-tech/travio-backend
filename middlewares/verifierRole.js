// middlewares/verifierRole.js

function verifierRole(roleRequis) {
  return (req, res, next) => {
    if (!req.user || req.user.role !== roleRequis) {
      return res.status(403).json({ message: 'Accès refusé — action réservée aux administrateurs.' });
    }
    next();
  };
}

module.exports = { verifierRole };