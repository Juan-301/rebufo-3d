// Proxy de OpenF1 para que el navegador consulte el mismo dominio (sin problemas de CORS)
// Uso: /api/openf1?p=<endpoint y query de OpenF1>, por ejemplo p=sessions%3Fyear%3D2025
const ALLOWED = /^(sessions|meetings|drivers|laps|position|location|intervals|car_data|stints|pit|race_control|weather)(\?|$)/;

export default async function handler(req, res) {
  const p = String(req.query.p || '');
  if (!ALLOWED.test(p)) {
    res.status(400).json({ error: 'Endpoint no permitido' });
    return;
  }
  try {
    const r = await fetch('https://api.openf1.org/v1/' + p, { headers: { accept: 'application/json' } });
    const body = await r.text();
    res.status(r.status);
    res.setHeader('content-type', r.headers.get('content-type') || 'application/json');
    // Los datos históricos no cambian: se guardan una hora en el CDN de Vercel
    res.setHeader('cache-control', r.ok ? 's-maxage=3600, stale-while-revalidate=86400' : 'no-store');
    res.send(body);
  } catch (e) {
    res.status(502).json({ error: 'No se pudo contactar a OpenF1' });
  }
}
