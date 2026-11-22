// Proxy de MultiViewer para obtener los números de curva de un circuito
// Uso: /api/circuit?c=<circuit_key>&y=<año>
export default async function handler(req, res) {
  const c = parseInt(req.query.c, 10), y = parseInt(req.query.y, 10);
  if (!c || !y) {
    res.status(400).json({ error: 'Faltan c y y' });
    return;
  }
  try {
    const r = await fetch(`https://api.multiviewer.app/api/v1/circuits/${c}/${y}`, { headers: { 'user-agent': 'rebufo-3d' } });
    const body = await r.text();
    res.status(r.status);
    res.setHeader('content-type', 'application/json');
    res.setHeader('cache-control', r.ok ? 's-maxage=86400' : 'no-store');
    res.send(body);
  } catch (e) {
    res.status(502).json({ error: 'No se pudo contactar a MultiViewer' });
  }
}
