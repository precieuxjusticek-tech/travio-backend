// Calcule quels tronçons sont couverts par un trajet montée→descente
function getSegmentsTrajet(trajet, arretMontee, arretDescente) {
  const allPoints = [
    trajet.villeDepart,
    ...(trajet.arrets || []).map(a => a.ville || a.nom),
    trajet.villeArrivee,
  ];
  const nbSegments = allPoints.length - 1;

  const monteeNom   = arretMontee   || trajet.villeDepart;
  const descenteNom = arretDescente || trajet.villeArrivee;

  const idxMontee   = allPoints.indexOf(monteeNom);
  const idxDescente = allPoints.indexOf(descenteNom);

  if (idxMontee === -1 || idxDescente === -1 || idxDescente <= idxMontee) {
    return null; // segment invalide
  }

  const segments = [];
  for (let i = idxMontee; i < idxDescente; i++) segments.push(i);

  return { segments, nbSegments };
}

module.exports = { getSegmentsTrajet };