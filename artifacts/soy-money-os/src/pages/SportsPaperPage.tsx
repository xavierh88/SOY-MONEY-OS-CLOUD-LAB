import { useEffect, useState } from "react";

export default function SportsPaperPage() {
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/sports-paper/history", { credentials: "include" })
      .then(r => {
        if (!r.ok) throw Error("HTTP " + r.status);
        return r.json();
      })
      .then(setData)
      .catch(e => setError(String(e)));
  }, []);

  const stats = data?.tripletMetrics;

  return <main style={{ padding: 24 }}>
    <h1>SOY Sports — PAPER</h1>
    <p>Tripletas, resultados y aciertos reales.</p>
    {error && <p role="alert">{error}</p>}
    {!data && !error && <p>Cargando...</p>}
    {stats && <section>
      <p>Tripletas: {stats.total} | Aciertos: {stats.hits}</p>
      <p>Fallos: {stats.misses} | Pendientes: {stats.pending}</p>
      <p>Porcentaje de aciertos: {stats.hitRate === null
        ? "Sin datos" : stats.hitRate + "%"}</p>
    </section>}
    {data?.triplets?.map((t: any) =>
      <section key={t.id} style={{ padding: 16, margin: 12,
        border: "1px solid gray", borderRadius: 10 }}>
        <h3>Tripleta: {t.status}</h3>
        <p>Cuota combinada: {t.combinedOdds ?? "N/D"}</p>
        {t.selections.map((s: any) =>
          <p key={s.id}>{s.homeTeam} vs {s.awayTeam}
            {" — "}{s.pick} @ {s.decimalOdds ?? "N/D"}
            {" — "}{s.status} {s.result ?? ""}</p>
        )}
      </section>
    )}
  </main>;
}
