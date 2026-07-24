const { firestore } = require('../firebase');
const { getSegmentsTrajet } = require('./segments');

async function verifierImpactReservations(departId, trajetId, today) {
  const sessionsSnap = await firestore.collection('sessions')
    .where('departId', '==', departId)
    .where('date', '>=', today)
    .get();

  const autresDepartsSnap = await firestore.collection('departs')
    .where('trajetId', '==', trajetId)
    .where('actif', '==', true)
    .get();
  const autresDeparts = autresDepartsSnap.docs
    .map(d => d.data())
    .filter(d => d.id !== departId);

  const sessions = [];
  let totalReservations = 0;

  for (const sDoc of sessionsSnap.docs) {
    const s = sDoc.data();
    if (s.statut === 'annulée') continue;

    const resasSnap = await firestore.collection('reservations')
      .where('sessionId', '==', s.id)
      .where('statut', '!=', 'annulée')
      .get();

    if (resasSnap.size > 0) {
      totalReservations += resasSnap.size;

      // ── NOUVEAU : total réel de passagers pour cette session ──
      const totalPassagersSession = resasSnap.docs.reduce((sum, rDoc) => sum + (rDoc.data().nbPassagers || 1), 0);

      // Arrêts requis par les réservations de cette session
      const arretsRequis = new Set();
      resasSnap.docs.forEach(rDoc => {
        const r = rDoc.data();
        if (r.arretMontee)   arretsRequis.add(r.arretMontee);
        if (r.arretDescente) arretsRequis.add(r.arretDescente);
      });

      // vérifier quels autres bus ont déjà une session ce jour-là ET desservent tous les arrêts requis
      const busesDisponibles = [];
      for (const d of autresDeparts) {
        const nomsArretsD = (d.arretsActifs || []).map(a => a.nom);
        const dessertTout = nomsArretsD.length === 0;
        const compatible  = dessertTout || [...arretsRequis].every(nom => nomsArretsD.includes(nom));
        if (!compatible) continue;

        const cibleSnap = await firestore.collection('sessions')
          .where('departId', '==', d.id)
          .where('date', '==', s.date)
          .get();

        if (!cibleSnap.empty) {
          const cibleSession = cibleSnap.docs[0].data();
          const placesLibres  = cibleSession.placesTotal - Math.max(0, ...(cibleSession.placesVenduesSegments || [cibleSession.placesVendues || 0]));

          // On n'ajoute le bus que s'il a de la place pour AU MOINS ce groupe de réservations
          if (placesLibres >= totalPassagersSession) {
            busesDisponibles.push({
              departId:     d.id,
              busNom:       d.busNom,
              heureDepart:  d.heureDepart,
              placesLibres,
            });
          }
        }
      }

      sessions.push({
        sessionId: s.id,
        date: s.date,
        heureDepart: s.heureDepart,
        nbReservations: resasSnap.size,
        busesDisponibles,
      });
    }
  }

  return { sessions, totalReservations };
}

async function verifierImpactReservationsVehicule(vehiculeId, today) {
  const departsSnap = await firestore.collection('departs')
    .where('vehiculeId', '==', vehiculeId).get();

  const sessionsBloquantes = [];
  let totalReservations = 0;

  for (const departDoc of departsSnap.docs) {
    const depart = departDoc.data();
    const impact = await verifierImpactReservations(depart.id, depart.trajetId, today);
    if (impact.sessions.length > 0) {
      totalReservations += impact.totalReservations;
      impact.sessions.forEach(s => sessionsBloquantes.push({
        ...s,
        departId: depart.id,
        trajetId: depart.trajetId,
        busNom:   depart.busNom,
      }));
    }
  }

  return { sessions: sessionsBloquantes, totalReservations };
}

async function verifierImpactReservationsTrajet(trajetId, today) {
  const departsSnap = await firestore.collection('departs')
    .where('trajetId', '==', trajetId).get();

  const sessionsBloquantes = [];
  let totalReservations = 0;

  for (const departDoc of departsSnap.docs) {
    const depart = departDoc.data();
    const impact = await verifierImpactReservations(depart.id, trajetId, today);
    if (impact.sessions.length > 0) {
      totalReservations += impact.totalReservations;
      impact.sessions.forEach(s => sessionsBloquantes.push({
        ...s,
        departId: depart.id,
        trajetId,
        busNom: depart.busNom,
      }));
    }
  }

  return { sessions: sessionsBloquantes, totalReservations };
}

module.exports = {
  verifierImpactReservations,
  verifierImpactReservationsVehicule,
  verifierImpactReservationsTrajet,
};