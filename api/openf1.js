// Proxy de OpenF1 para que el navegador consulte el mismo dominio (sin problemas de CORS)
// Uso: /api/openf1?p=<endpoint y query de OpenF1>, por ejemplo p=sessions%3Fyear%3D2025
const ALLOWED = /^(sessions|meetings|drivers|laps|position|location|intervals|car_data|stints|pit|race_control|weather)(\?|$)/;
const sleep = ms => new Promise(r => setTimeout(r, ms));

export default async function handler(req, res) {
  const p = String(req.query.p || '');
  if (!ALLOWED.test(p)) {
    res.status(400).json({ error: 'Endpoint no permitido' });
    return;
  }
  let r = null, body = '';
  for (let a = 0; a < 3; a++) {
    try {
      r = await fetch('https://api.openf1.org/v1/' + p, {
        headers: { accept: 'application/json', 'user-agent': 'rebufo-3d (+https://rebufo-beta.vercel.app)' }
      });
      body = await r.text();
      if (r.status < 500) break;
    } catch (e) {
      r = null; body = String(e && e.message || e);
    }
    await sleep(700 * (a + 1));
  }
  if (!r) {
    res.status(502).json({ error: 'No se pudo contactar a OpenF1', detail: body.slice(0, 300) });
    return;
  }
  res.setHeader('cache-control', r.ok ? 's-maxage=3600, stale-while-revalidate=86400' : 'no-store');
  if (r.ok) {
    res.status(200);
    res.setHeader('content-type', r.headers.get('content-type') || 'application/json');
    res.send(body);
  } else {
    res.status(r.status).json({ error: 'OpenF1 respondió ' + r.status, detail: body.slice(0, 300) });
  }
}
