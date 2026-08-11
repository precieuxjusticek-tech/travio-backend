// middlewares/verifierRole.js

function verifierRole(roleRequis) {
  return (req, res, next) => {
    if (!req.user || req.user.role !== roleRequis) {
      return res.status(403).json({ message: 'Accès refusé — action réservée aux administrateurs.' });
    }
    next();
  };
}

function verifierRoleOuSysteme(roleRequis) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(403).json({ message: 'Accès refusé.' });
    }
    if (req.user.role === 'system' || req.user.role === roleRequis) {
      return next();
    }
    return res.status(403).json({ message: 'Accès refusé — action réservée aux administrateurs.' });
  };
}

module.exports = { verifierRole, verifierRoleOuSysteme };