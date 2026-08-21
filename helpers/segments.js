function getSegmentsTrajet(trajet, arretMontee, arretDescente) {
  const villesArrets = [];
  (trajet.arrets || []).forEach(a => {
    const ville = a.ville || a.nom;
    if (ville && !villesArrets.includes(ville)) villesArrets.push(ville);
  });

  const allPoints = [
    trajet.villeDepart,
    ...villesArrets,
    trajet.villeArrivee,
  ];
  const nbSegments = allPoints.length - 1;

  const monteeNom   = arretMontee   || trajet.villeDepart;
  const descenteNom = arretDescente || trajet.villeArrivee;

  const idxMontee   = allPoints.indexOf(monteeNom);
  const idxDescente = allPoints.indexOf(descenteNom);

  if (idxMontee === -1 || idxDescente === -1 || idxDescente <= idxMontee) {
    return null;
  }

  const segments = [];
  for (let i = idxMontee; i < idxDescente; i++) segments.push(i);

  return { segments, nbSegments };
}

module.exports = { getSegmentsTrajet };