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

// Sessões em memória: { sessionId -> { accessToken, refreshToken, tokenExpiry } }
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

// Hora do servidor em UTC — frontend usa para calcular GMT-3 consistente
app.get('/api/hora', (req, res) => {
  res.json({ utc: Date.now() });
});

// Debug: pedido RAW
app.get('/debug/pedido/:id', async (req, res) => {
  let token;
  try { token = await ensureToken(req); }
  catch(e) { return res.status(401).json({ error: 'Nao autenticado' }); }
  const options = {
    hostname: 'www.bling.com.br',
    path: '/Api/v3/pedidos/vendas/' + req.params.id,
    method: 'GET',
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' }
  };
  const request = https.request(options, (response) => {
    let data = '';
    response.on('data', c => data += c);
    response.on('end', () => {
      try { res.json(JSON.parse(data)); }
      catch(e) { res.json({ raw: data }); }
    });
  });
  request.on('error', err => res.status(500).json({ error: err.message }));
  request.end();
});

// Debug: múltiplos pedidos
app.get('/debug/pedidos/:ids', async (req, res) => {
  let token;
  try { token = await ensureToken(req); }
  catch(e) { return res.status(401).json({ error: 'Nao autenticado' }); }
  const ids = req.params.ids.split(',').slice(0, 5);
  const results = await Promise.all(ids.map(id => new Promise((resolve) => {
    const options = {
      hostname: 'www.bling.com.br',
      path: '/Api/v3/pedidos/vendas/' + id.trim(),
      method: 'GET',
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' }
    };
    const request = https.request(options, (response) => {
      let data = '';
      response.on('data', c => data += c);
      response.on('end', () => {
        try {
          const d = JSON.parse(data).data || {};
          resolve({ id: d.id, numero: d.numero, data: d.data, situacao: d.situacao });
        } catch(e) { resolve({ id, error: data.slice(0,100) }); }
      });
    });
    request.on('error', err => resolve({ id, error: err.message }));
    request.end();
  })));
  res.json(results);
});

// Debug: lista depósitos
app.get('/debug/depositos', async (req, res) => {
  let token;
  try { token = await ensureToken(req); }
  catch(e) { return res.status(401).json({ error: 'Nao autenticado' }); }
  const options = {
    hostname: 'www.bling.com.br',
    path: '/Api/v3/depositos',
    method: 'GET',
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' }
  };
  const request = https.request(options, (response) => {
    let data = '';
    response.on('data', c => data += c);
    response.on('end', () => {
      try { res.json(JSON.parse(data)); }
      catch(e) { res.json({ raw: data }); }
    });
  });
  request.on('error', err => res.status(500).json({ error: err.message }));
  request.end();
});

// Debug: saldos por depósito
app.get('/debug/saldos', async (req, res) => {
  let token;
  try { token = await ensureToken(req); }
  catch(e) { return res.status(401).json({ error: 'Nao autenticado' }); }
  const options = {
    hostname: 'www.bling.com.br',
    path: '/Api/v3/estoques/saldos?pagina=1&limite=5' + (req.query.id ? '&idsProdutos[]=' + req.query.id : ''),
    method: 'GET',
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' }
  };
  const request = https.request(options, (response) => {
    let data = '';
    response.on('data', c => data += c);
    response.on('end', () => {
      try { res.json(JSON.parse(data)); }
      catch(e) { res.json({ raw: data }); }
    });
  });
  request.on('error', err => res.status(500).json({ error: err.message }));
  request.end();
});

// Debug: situações de pedidos num período
app.get('/debug/situacoes', async (req, res) => {
  let token;
  try { token = await ensureToken(req); }
  catch(e) { return res.status(401).json({ error: 'Nao autenticado' }); }
  const dataIni = req.query.de || new Date(Date.now()-86400000).toISOString().split('T')[0];
  const dataFim = req.query.ate || new Date().toISOString().split('T')[0];
  const options = {
    hostname: 'www.bling.com.br',
    path: '/Api/v3/pedidos/vendas?dataInicial='+dataIni+'&dataFinal='+dataFim+'&pagina=1&limite=100',
    method: 'GET',
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' }
  };
  const request = https.request(options, (response) => {
    let data = '';
    response.on('data', c => data += c);
    response.on('end', () => {
      try {
        const json = JSON.parse(data);
        const contagem = {};
        (json.data||[]).forEach(function(p) {
          var sit = (p.situacao && p.situacao.id) ? p.situacao.id+' ('+p.situacao.nome+')' : 'sem situacao';
          contagem[sit] = (contagem[sit]||0) + 1;
        });
        res.json({ total: (json.data||[]).length, situacoes: contagem, periodo: {de: dataIni, ate: dataFim} });
      } catch(e) { res.json({ raw: data }); }
    });
  });
  request.on('error', err => res.status(500).json({ error: err.message }));
  request.end();
});

// ─── SYNC COMPLETO NO SERVIDOR ───────────────────────────────────────────────
// Cache de progresso por sessão
const syncProgress = {};

function blingFetch(token, path) {
  return new Promise((resolve, reject) => {
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
        try { resolve({ status: response.statusCode, json: JSON.parse(data) }); }
        catch(e) { resolve({ status: response.statusCode, json: {} }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function blingFetchRetry(token, path, tentativa = 1) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const res = await blingFetch(token, path);
  if (res.status === 429 && tentativa <= 5) {
    await sleep(1200 * tentativa);
    return blingFetchRetry(token, path, tentativa + 1);
  }
  return res.json;
}

// GET /api/sync?dataIni=YYYY-MM-DD
app.get('/api/sync', async (req, res) => {
  let token;
  try { token = await ensureToken(req); }
  catch(e) { return res.status(401).json({ error: 'Nao autenticado' }); }

  const sid = parseCookie(req.headers.cookie || '')['sid'];
  const dataIni = req.query.dataIni || new Date(Date.now()-30*86400000).toISOString().split('T')[0];
  const dataFim = new Date().toISOString().split('T')[0];
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // Inicia sync assíncrono
  syncProgress[sid] = { status: 'running', pct: 0, msg: 'Iniciando...' };

  // Roda em background
  (async () => {
    try {
      // 1. Produtos
      syncProgress[sid] = { status: 'running', pct: 5, msg: 'Carregando produtos...' };
      let produtos = [], pagina = 1;
      while (true) {
        if (pagina > 1) await sleep(400);
        const r = await blingFetchRetry(token, '/produtos?pagina='+pagina+'&limite=100&situacao=A');
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

      // 2. Saldos por depósito
      syncProgress[sid] = { status: 'running', pct: 15, msg: 'Carregando saldos...' };
      const DEP_FAT = 14888413957, DEP_FULL = 14888519189;
      const saldos = {};
      const ids = produtos.map(p => p.id);
      for (let si = 0; si < ids.length; si += 20) {
        if (si > 0) await sleep(400);
        const qs = ids.slice(si, si+20).map(id => 'idsProdutos[]='+id).join('&');
        const rs = await blingFetchRetry(token, '/estoques/saldos?'+qs);
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

      // 3. Listagem de pedidos
      syncProgress[sid] = { status: 'running', pct: 25, msg: 'Listando pedidos...' };
      const SITS = [{id:15,origem:'normal'},{id:21,origem:'normal'},{id:529911,origem:'fulfillment'}];
      let listaIds = [];
      for (const sit of SITS) {
        await sleep(400);
        pagina = 1;
        while (true) {
          if (pagina > 1) await sleep(400);
          const rp = await blingFetchRetry(token, '/pedidos/vendas?dataInicial='+dataIni+'&dataFinal='+dataFim+'&situacao='+sit.id+'&pagina='+pagina+'&limite=100');
          const ip = rp.data || [];
          ip.forEach(p => { if (p.id) listaIds.push({id:p.id, data:p.data, origem:sit.origem}); });
          if (ip.length < 100) break;
          pagina++;
          if (pagina > 20) break;
        }
      }
      // Dedup: fulfillment tem prioridade
      const idMap = {};
      listaIds.forEach(p => { if (!idMap[p.id] || p.origem==='fulfillment') idMap[p.id] = p; });
      listaIds = Object.values(idMap);

      // 4. Detalhes dos pedidos
      const total = listaIds.length;
      const pedidos = [];
      for (let i = 0; i < listaIds.length; i += 3) {
        if (i > 0) await sleep(400);
        const lote = listaIds.slice(i, i+3);
        const results = await Promise.all(lote.map(ref =>
          blingFetchRetry(token, '/pedidos/vendas/'+ref.id).then(rs => {
            const pedido = rs.data;
            if (!pedido || pedido.error) return null;
            if (!pedido.data) pedido.data = ref.data;
            const sitId = pedido.situacao && pedido.situacao.id;
            pedido._origem = sitId === 529911 ? 'fulfillment' : 'normal';
            return pedido;
          }).catch(() => null)
        ));
        results.forEach(p => { if (p) pedidos.push(p); });
        const pct = 30 + Math.round((i / total) * 65);
        syncProgress[sid] = { status: 'running', pct, msg: 'Buscando pedidos... '+Math.min(i+3,total)+'/'+total };
      }

      syncProgress[sid] = {
        status: 'done', pct: 100, msg: 'Concluído',
        data: { produtos, saldos, pedidos }
      };
    } catch(e) {
      syncProgress[sid] = { status: 'error', msg: e.message };
    }
  })();

  res.json({ ok: true });
});

// GET /api/sync-status — consulta progresso
app.get('/api/sync-status', (req, res) => {
  const sid = parseCookie(req.headers.cookie || '')['sid'];
  const prog = syncProgress[sid];
  if (!prog) return res.json({ status: 'idle' });
  if (prog.status === 'done') {
    const result = { ...prog };
    delete syncProgress[sid]; // limpa após entregar
    return res.json(result);
  }
  res.json({ status: prog.status, pct: prog.pct, msg: prog.msg });
});
  const sid = parseCookie(req.headers.cookie || '')['sid'];
  if (sid) delete sessions[sid];
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; Max-Age=0; Path=/');
  res.redirect('/');
});

// Busca detalhes de pedidos no servidor — evita rate limit no browser
// GET /api/pedidos-detalhes?ids=1,2,3,...
app.get('/api/pedidos-detalhes', async (req, res) => {
  let token;
  try { token = await ensureToken(req); }
  catch(e) { return res.status(401).json({ error: 'Nao autenticado' }); }

  const ids = (req.query.ids || '').split(',').filter(Boolean);
  if (!ids.length) return res.json({ data: [] });

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // Busca um pedido com retry em caso de 429
  function fetchPedido(id, tentativa = 1) {
    return new Promise((resolve) => {
      const options = {
        hostname: 'www.bling.com.br',
        path: '/Api/v3/pedidos/vendas/' + id,
        method: 'GET',
        headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' }
      };
      const request = https.request(options, (response) => {
        let data = '';
        response.on('data', c => data += c);
        response.on('end', async () => {
          if (response.statusCode === 429 && tentativa <= 5) {
            console.log('[pedidos-detalhes] 429 id='+id+' tentativa='+tentativa);
            await sleep(1500 * tentativa);
            resolve(fetchPedido(id, tentativa + 1));
          } else {
            try {
              const json = JSON.parse(data);
              resolve(json.data || null);
            } catch(e) { resolve(null); }
          }
        });
      });
      request.on('error', () => resolve(null));
      request.end();
    });
  }

  // Processa em lotes de 3 com delay de 400ms entre lotes
  const results = [];
  for (let i = 0; i < ids.length; i += 3) {
    if (i > 0) await sleep(400);
    const lote = ids.slice(i, i + 3);
    const loteRes = await Promise.all(lote.map(id => fetchPedido(id)));
    loteRes.forEach(p => { if (p) results.push(p); });
    console.log('[pedidos-detalhes] '+Math.min(i+3, ids.length)+'/'+ids.length);
  }

  res.json({ data: results });
});

// Proxy para a API do Bling
app.use('/api/bling', async (req, res) => {
  let token;
  try { token = await ensureToken(req); }
  catch(e) { return res.status(401).json({ error: 'Nao autenticado' }); }

  const qs = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '';
  const blingPath = '/Api/v3' + req.path + qs;
  console.log('[PROXY]', req.method, blingPath);

  const options = {
    hostname: 'www.bling.com.br',
    path: blingPath,
    method: req.method,
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' }
  };

  const request = https.request(options, (response) => {
    let data = '';
    response.on('data', c => data += c);
    response.on('end', () => {
      console.log('[PROXY] status:', response.statusCode, '| bytes:', data.length);
      try { res.status(response.statusCode).json(JSON.parse(data)); }
      catch(e) { res.status(500).json({ error: 'Resposta invalida', raw: data.slice(0, 200) }); }
    });
  });
  request.on('error', err => res.status(500).json({ error: err.message }));
  request.end();
});

app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.sendFile(__dirname + '/index.html');
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log('Painel rodando na porta ' + PORT));
