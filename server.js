const express = require('express');
const https = require('https');
const querystring = require('querystring');
const crypto = require('crypto');
const app = express();
app.use(express.json());

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const BASE_URL = process.env.PUBLIC_DOMAIN
  ? 'https://' + process.env.PUBLIC_DOMAIN
  : process.env.RAILWAY_PUBLIC_DOMAIN
    ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN
    : 'http://localhost:8080';
const REDIRECT_URI = BASE_URL + '/callback';

const sessions = {};

function getSession(req) {
  const sid = parseCookie(req.headers.cookie || '')['sid'];
  return sid && sessions[sid] ? { sid, ...sessions[sid] } : null;
}

function parseCookie(str) {
  return str.split(';').reduce((acc, part) => {
    const [k, ...v] = part.trim().split('=');
    if (k) acc[k.trim()] = decodeURIComponent(v.join('='));
    return acc;
  }, {});
}

app.get('/login', (req, res) => {
  const params = querystring.stringify({
    response_type: 'code', client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI, state: 'painel'
  });
  res.redirect('https://www.bling.com.br/Api/v3/oauth/authorize?' + params);
});

app.get('/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.send('Erro: codigo nao recebido');
  try {
    const token = await fetchToken('authorization_code', { code, redirect_uri: REDIRECT_URI });
    const sid = crypto.randomBytes(24).toString('hex');
    sessions[sid] = {
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      tokenExpiry: Date.now() + (token.expires_in * 1000)
    };
    res.setHeader('Set-Cookie', 'sid=' + sid + '; HttpOnly; SameSite=Lax; Max-Age=21600; Path=/');
    res.redirect('/');
  } catch (err) { res.send('Erro ao obter token: ' + err.message); }
});

async function ensureToken(req) {
  const sess = getSession(req);
  if (!sess) throw new Error('Nao autenticado');
  if (Date.now() > sess.tokenExpiry - 60000) {
    const token = await fetchToken('refresh_token', { refresh_token: sess.refreshToken });
    sessions[sess.sid].accessToken = token.access_token;
    sessions[sess.sid].refreshToken = token.refresh_token || sess.refreshToken;
    sessions[sess.sid].tokenExpiry = Date.now() + (token.expires_in * 1000);
    return sessions[sess.sid].accessToken;
  }
  return sess.accessToken;
}

function fetchToken(grantType, params) {
  return new Promise((resolve, reject) => {
    const body = querystring.stringify(Object.assign({ grant_type: grantType, redirect_uri: REDIRECT_URI }, params));
    const credentials = Buffer.from(CLIENT_ID + ':' + CLIENT_SECRET).toString('base64');
    const options = {
      hostname: 'www.bling.com.br', path: '/Api/v3/oauth/token', method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        'Authorization': 'Basic ' + credentials,
        'Accept': 'application/json'
      }
    };
    const req = https.request(options, (response) => {
      let data = '';
      response.on('data', c => data += c);
      response.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) reject(new Error(JSON.stringify(json)));
          else resolve(json);
        } catch(e) { reject(new Error('Resposta invalida: ' + data)); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

app.get('/auth/status', (req, res) => {
  const sess = getSession(req);
  res.json({ authenticated: !!(sess && Date.now() < sess.tokenExpiry) });
});

// Hora do servidor para sincronização de fuso
app.get('/api/hora', (req, res) => {
  res.json({ utc: Date.now() });
});

// Helpers de requisição ao Bling
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function blingGet(token, path, tentativa = 1) {
  const json = await new Promise((resolve, reject) => {
    const options = {
      hostname: 'www.bling.com.br',
      path: '/Api/v3' + path,
      method: 'GET',
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' }
    };
    const req = https.request(options, (response) => {
      let data = '';
      response.on('data', c => data += c);
      response.on('end', () => {
        try { resolve({ status: response.statusCode, body: JSON.parse(data) }); }
        catch(e) { resolve({ status: response.statusCode, body: {} }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
  if (json.status === 429 && tentativa <= 5) {
    console.log('[429] aguardando ' + (1000 * tentativa) + 'ms, tentativa ' + tentativa);
    await sleep(1000 * tentativa);
    return blingGet(token, path, tentativa + 1);
  }
  return json.body;
}

// ─── SYNC COMPLETO — síncrono, responde direto ────────────────────────────────
app.get('/api/sync', async (req, res) => {
  let token;
  try { token = await ensureToken(req); }
  catch(e) { return res.status(401).json({ error: 'Nao autenticado' }); }

  const dataIni = req.query.dataIni || new Date(Date.now()-30*86400000).toISOString().split('T')[0];
  const dataFim = new Date().toISOString().split('T')[0];
  const DEP_FAT = 14888413957, DEP_FULL = 14888519189;

  try {
    // 1. Produtos
    let produtos = [], pagina = 1;
    while (true) {
      if (pagina > 1) await sleep(400);
      const r = await blingGet(token, '/produtos?pagina='+pagina+'&limite=100&situacao=A');
      const items = r.data || [];
      produtos = produtos.concat(items);
      if (items.length < 100) break;
      pagina++;
      if (pagina > 30) break;
    }
    produtos = produtos.filter(p => {
      if (!p.codigo || !String(p.codigo).startsWith('0')) return false;
      return !(p.nome||'').toLowerCase().includes('kit');
    });
    console.log('[sync] produtos: ' + produtos.length);

    // 2. Saldos
    const saldos = {};
    const ids = produtos.map(p => p.id);
    for (let si = 0; si < ids.length; si += 20) {
      if (si > 0) await sleep(400);
      const qs = ids.slice(si, si+20).map(id => 'idsProdutos[]='+id).join('&');
      const rs = await blingGet(token, '/estoques/saldos?'+qs);
      (rs.data||[]).forEach(item => {
        const pid = item.produto && item.produto.id;
        if (!pid) return;
        let fat = 0, full = 0;
        (item.depositos||[]).forEach(dep => {
          if (dep.id === DEP_FAT) fat = dep.saldoVirtual || 0;
          else if (dep.id === DEP_FULL) full = dep.saldoVirtual || 0;
        });
        saldos[pid] = { fat, full };
      });
    }
    console.log('[sync] saldos: ' + Object.keys(saldos).length);

    // 3. Listagem de pedidos
    const SITS = [{id:15,origem:'normal'},{id:21,origem:'normal'},{id:529911,origem:'fulfillment'}];
    let listaIds = [];
    for (const sit of SITS) {
      await sleep(400);
      pagina = 1;
      while (true) {
        if (pagina > 1) await sleep(400);
        const rp = await blingGet(token, '/pedidos/vendas?dataInicial='+dataIni+'&dataFinal='+dataFim+'&situacao='+sit.id+'&pagina='+pagina+'&limite=100');
        const ip = rp.data || [];
        ip.forEach(p => { if (p.id) listaIds.push({id:p.id, data:p.data, origem:sit.origem}); });
        if (ip.length < 100) break;
        pagina++;
        if (pagina > 20) break;
      }
    }
    // Dedup
    const idMap = {};
    listaIds.forEach(p => { if (!idMap[p.id] || p.origem==='fulfillment') idMap[p.id] = p; });
    listaIds = Object.values(idMap);
    console.log('[sync] pedidos listados: ' + listaIds.length);

    // 4. Detalhes dos pedidos (lotes de 3, delay 400ms)
    const pedidos = [];
    for (let i = 0; i < listaIds.length; i += 3) {
      if (i > 0) await sleep(400);
      const lote = listaIds.slice(i, i+3);
      const results = await Promise.all(lote.map(ref =>
        blingGet(token, '/pedidos/vendas/'+ref.id).then(rs => {
          const pedido = rs.data;
          if (!pedido || pedido.error) return null;
          if (!pedido.data) pedido.data = ref.data;
          const sitId = pedido.situacao && pedido.situacao.id;
          pedido._origem = sitId === 529911 ? 'fulfillment' : 'normal';
          return pedido;
        }).catch(() => null)
      ));
      results.forEach(p => { if (p) pedidos.push(p); });
      if (i % 30 === 0) console.log('[sync] pedidos detalhados: ' + pedidos.length + '/' + listaIds.length);
    }
    console.log('[sync] concluído: ' + pedidos.length + ' pedidos');

    res.json({ produtos, saldos, pedidos });

  } catch(e) {
    console.error('[sync] erro:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Debug endpoints
app.get('/debug/pedido/:id', async (req, res) => {
  let token;
  try { token = await ensureToken(req); }
  catch(e) { return res.status(401).json({ error: 'Nao autenticado' }); }
  const r = await blingGet(token, '/pedidos/vendas/' + req.params.id);
  res.json(r);
});

app.get('/debug/pedidos/:ids', async (req, res) => {
  let token;
  try { token = await ensureToken(req); }
  catch(e) { return res.status(401).json({ error: 'Nao autenticado' }); }
  const ids = req.params.ids.split(',').slice(0, 5);
  const results = await Promise.all(ids.map(id =>
    blingGet(token, '/pedidos/vendas/' + id.trim()).then(rs => {
      const d = rs.data || {};
      return { id: d.id, numero: d.numero, data: d.data, situacao: d.situacao };
    }).catch(e => ({ id, error: e.message }))
  ));
  res.json(results);
});

app.get('/debug/saldos', async (req, res) => {
  let token;
  try { token = await ensureToken(req); }
  catch(e) { return res.status(401).json({ error: 'Nao autenticado' }); }
  const path = '/estoques/saldos?pagina=1&limite=5' + (req.query.id ? '&idsProdutos[]=' + req.query.id : '');
  const r = await blingGet(token, path);
  res.json(r);
});

app.get('/debug/depositos', async (req, res) => {
  let token;
  try { token = await ensureToken(req); }
  catch(e) { return res.status(401).json({ error: 'Nao autenticado' }); }
  const r = await blingGet(token, '/depositos');
  res.json(r);
});

app.get('/debug/situacoes', async (req, res) => {
  let token;
  try { token = await ensureToken(req); }
  catch(e) { return res.status(401).json({ error: 'Nao autenticado' }); }
  const dataIni = req.query.de || new Date(Date.now()-86400000).toISOString().split('T')[0];
  const dataFim = req.query.ate || new Date().toISOString().split('T')[0];
  const r = await blingGet(token, '/pedidos/vendas?dataInicial='+dataIni+'&dataFinal='+dataFim+'&pagina=1&limite=100');
  const contagem = {};
  (r.data||[]).forEach(p => {
    const sit = p.situacao ? p.situacao.id + ' (' + (p.situacao.nome||'?') + ')' : 'sem situacao';
    contagem[sit] = (contagem[sit]||0) + 1;
  });
  res.json({ total: (r.data||[]).length, situacoes: contagem, periodo: {de: dataIni, ate: dataFim} });
});

app.get('/logout', (req, res) => {
  const sid = parseCookie(req.headers.cookie || '')['sid'];
  if (sid) delete sessions[sid];
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; Max-Age=0; Path=/');
  res.redirect('/');
});

// Proxy para a API do Bling (usado pelo syncLeve no frontend)
app.use('/api/bling', async (req, res) => {
  let token;
  try { token = await ensureToken(req); }
  catch(e) { return res.status(401).json({ error: 'Nao autenticado' }); }
  const qs = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '';
  const blingPath = '/Api/v3' + req.path + qs;
  const r = await blingGet(token, blingPath.replace('/Api/v3',''));
  res.json(r);
});

app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.sendFile(__dirname + '/index.html');
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log('Painel rodando na porta ' + PORT));
