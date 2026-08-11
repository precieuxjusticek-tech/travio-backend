// helpers/batch.js
// Batch Firestore auto-découpé pour rester sous la limite de 500 ops par commit,
// avec commit séquentiel et traçabilité des échecs.
function creerBatchAutoCommit(firestore, limite = 450) {
  let batch = firestore.batch();
  let count = 0;
  let refsEnCours = [];

  const chunksReussis = [];
  const chunksEchoues = [];

  async function flush() {
    if (count === 0) return;
    const refsDuChunk = refsEnCours;
    const batchActuel = batch;

    batch = firestore.batch();
    count = 0;
    refsEnCours = [];

    try {
      await batchActuel.commit();
      chunksReussis.push(refsDuChunk);
    } catch (err) {
      chunksEchoues.push({ refs: refsDuChunk, erreur: err.message });
      throw err; // on stoppe : pas de nouveau chunk lancé après un échec
    }
  }

  async function flushSiNecessaire() {
    if (count >= limite) await flush();
  }

  return {
    async set(ref, data) {
      batch.set(ref, data);
      refsEnCours.push(ref.id);
      count++;
      await flushSiNecessaire();
    },
    async update(ref, data) {
      batch.update(ref, data);
      refsEnCours.push(ref.id);
      count++;
      await flushSiNecessaire();
    },
    async delete(ref) {
      batch.delete(ref);
      refsEnCours.push(ref.id);
      count++;
      await flushSiNecessaire();
    },
    async commitFinal() {
      await flush();
      return {
        succes: chunksEchoues.length === 0,
        idsReussis: chunksReussis.flat(),
        idsEchoues: chunksEchoues.flatMap(c => c.refs),
        erreurs: chunksEchoues.map(c => c.erreur),
      };
    },
  };
}

module.exports = { creerBatchAutoCommit };