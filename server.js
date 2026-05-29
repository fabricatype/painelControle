const express = require('express');
const https = require('https');
const http = require('http');
const querystring = require('querystring');
const app = express();
app.use(express.json());

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const BASE_URL = process.env.RAILWAY_PUBLIC_DOMAIN 
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` 
  : 'http://localhost:8080';

const REDIRECT_URI = `${BASE_URL}/callback`;

// Armazena tokens em memória (simples, funciona para 1 usuário)
let accessToken = null;
let refreshToken = null;
let tokenExpiry = null;

// ── OAuth Login ──────────────────────────────────────────────────────────────
app.get('/login', (req, res) => {
  const params = querystring.stringify({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    state: 'painel'
  });
  res.redirect(`https://www.bling.com.br/Api/v3/oauth/authorize?${params}`);
});

// ── OAuth Callback ───────────────────────────────────────────────────────────
app.get('/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.send('Erro: código não recebido');

  try {
    const token = await fetchToken('authorization_code', { code, redirect_uri: REDIRECT_URI });
    accessToken = token.access_token;
    refreshToken = token.refresh_token;
    tokenExpiry = Date.now() + (token.expires_in * 1000);
    res.redirect('/');
  } catch (err) {
    res.send('Erro ao obter token: ' + err.message);
  }
});

// ── Refresh Token ────────────────────────────────────────────────────────────
async function ensureToken() {
  if (!accessToken) throw new Error('Não autenticado');
  if (Date.now() > tokenExpiry - 60000) {
    const token = await fetchToken('refresh_token', { refresh_token: refreshToken });
    accessToken = token.access_token;
    refreshToken = token.refresh_token || refreshToken;
    tokenExpiry = Date.now() + (token.expires_in * 1000);
  }
}

function fetchToken(grantType, params) {
  return new Promise((resolve, reject) => {
    const body = querystring.stringify({
      grant_type: grantType,
      redirect_uri: REDIRECT_URI,
      ...params
    });

    const credentials = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');

    const options = {
      hostname: 'www.bling.com.br',
      path: '/Api/v3/oauth/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        'Authorization': `Basic ${credentials}`,
        'Accept': 'application/json'
      }
    };

    const req = https.request(options, (response) => {
      let data = '';
      response.on('data', chunk => data += chunk);
      response.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) reject(new Error(JSON.stringify(json)));
          else resolve(json);
        } catch { reject(new Error('Resposta inválida: ' + data)); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Debug ────────────────────────────────────────────────────────────────────
app.get('/debug/produto', async (req, res) => {
  try {
    await ensureToken();
    const opts = { hostname:'www.bling.com.br', path:'/Api/v3/produtos?pagina=1&limite=1&situacao=A', method:'GET', headers:{ Authorization:'Bearer '+accessToken, Accept:'application/json' } };
    const r = https.request(opts, (response) => { let d=''; response.on('data',c=>d+=c); response.on('end',()=>res.send('<pre>'+JSON.stringify(JSON.parse(d),null,2)+'</pre>')); });
    r.on('error', err=>res.status(500).send(err.message)); r.end();
  } catch(e){ res.status(401).send('Nao autenticado'); }
});

app.get('/debug/estoque/:id', async (req, res) => {
  try {
    await ensureToken();
    const opts = { hostname:'www.bling.com.br', path:'/Api/v3/estoques/'+req.params.id, method:'GET', headers:{ Authorization:'Bearer '+accessToken, Accept:'application/json' } };
    const r = https.request(opts, (response) => { let d=''; response.on('data',c=>d+=c); response.on('end',()=>res.send('<pre>'+JSON.stringify(JSON.parse(d),null,2)+'</pre>')); });
    r.on('error', err=>res.status(500).send(err.message)); r.end();
  } catch(e){ res.status(401).send('Nao autenticado'); }
});

// ── Status Auth ──────────────────────────────────────────────────────────────
app.get('/auth/status', (req, res) => {
  res.json({ authenticated: !!accessToken && Date.now() < tokenExpiry });
});

// ── Proxy Bling API ──────────────────────────────────────────────────────────
app.use('/api/bling', async (req, res) => {
  try {
    await ensureToken();
  } catch {
    return res.status(401).json({ error: 'Não autenticado', loginUrl: '/login' });
  }

  const qs = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '';
  const blingPath = `/Api/v3${req.path}${qs}`;

  const options = {
    hostname: 'www.bling.com.br',
    path: blingPath,
    method: req.method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json'
    }
  };

  const request = https.request(options, (response) => {
    let data = '';
    response.on('data', chunk => data += chunk);
    response.on('end', () => {
      try { res.status(response.statusCode).json(JSON.parse(data)); }
      catch { res.status(500).json({ error: 'Resposta inválida do Bling' }); }
    });
  });
  request.on('error', err => res.status(500).json({ error: err.message }));
  request.end();
});

// ── Frontend ─────────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.send(HTML));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Painel rodando na porta ${PORT}`));

// ── HTML ─────────────────────────────────────────────────────────────────────
const HTML = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Controle de Estoque</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f5f5;color:#1a1a1a;font-size:14px}
  header{background:#fff;border-bottom:1px solid #e5e5e5;padding:14px 24px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:100}
  header h1{font-size:16px;font-weight:600}
  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;padding:16px 24px}
  .card{background:#fff;border:1px solid #e5e5e5;border-radius:10px;padding:14px 16px}
  .card .num{font-size:28px;font-weight:600;margin-bottom:2px}
  .card .lbl{font-size:12px;color:#888}
  .card.critico .num{color:#dc2626}
  .card.atencao .num{color:#d97706}
  .card.ok .num{color:#16a34a}
  .top-bar{padding:0 24px 16px;display:flex;gap:10px;flex-wrap:wrap;align-items:center}
  .table-wrap{padding:0 24px 32px;overflow-x:auto}
  table{width:100%;background:#fff;border-radius:10px;border:1px solid #e5e5e5;border-collapse:separate;border-spacing:0;overflow:hidden}
  th{background:#fafafa;padding:10px 14px;text-align:left;font-size:12px;font-weight:500;color:#666;border-bottom:1px solid #e5e5e5;white-space:nowrap}
  td{padding:10px 14px;border-bottom:1px solid #f0f0f0;vertical-align:middle}
  tr:last-child td{border-bottom:none}
  tr:hover td{background:#fafafa}
  .badge{display:inline-flex;align-items:center;gap:4px;padding:3px 8px;border-radius:20px;font-size:11px;font-weight:500}
  .badge.critico{background:#fef2f2;color:#dc2626}
  .badge.atencao{background:#fffbeb;color:#d97706}
  .badge.ok{background:#f0fdf4;color:#16a34a}
  .dot{width:6px;height:6px;border-radius:50%;background:currentColor}
  select,input[type=text]{padding:7px 12px;border:1px solid #e5e5e5;border-radius:8px;font-size:13px;background:#fff;outline:none}
  select:focus,input:focus{border-color:#7c7af8}
  button{padding:8px 16px;border-radius:8px;border:1px solid #e5e5e5;background:#fff;font-size:13px;cursor:pointer;font-weight:500;transition:.15s}
  button:hover{background:#f5f5f5}
  button.primary{background:#7c7af8;color:#fff;border-color:#7c7af8}
  button.primary:hover{background:#6b69e8}
  .login-screen{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:70vh;gap:16px;text-align:center}
  .login-screen h2{font-size:20px;font-weight:600}
  .login-screen p{color:#888;font-size:14px;max-width:340px}
  .tag{display:inline-block;padding:2px 8px;border-radius:6px;background:#f0f0f0;font-size:11px;color:#555}
  .dias-badge{font-size:12px;font-weight:600;padding:2px 8px;border-radius:6px}
  .dias-badge.r{background:#fef2f2;color:#dc2626}
  .dias-badge.a{background:#fffbeb;color:#d97706}
  .dias-badge.g{background:#f0fdf4;color:#16a34a}
  .loading{text-align:center;padding:48px;color:#888}
  .empty{text-align:center;padding:48px;color:#aaa;font-size:13px}
  .config-modal{display:none;position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:200;align-items:center;justify-content:center}
  .config-modal.open{display:flex}
  .modal{background:#fff;border-radius:14px;padding:24px;width:380px;max-width:90vw}
  .modal h2{font-size:16px;font-weight:600;margin-bottom:16px}
  .modal label{display:block;font-size:12px;color:#666;margin-bottom:4px;margin-top:12px}
  .modal input{width:100%;padding:9px 12px;border:1px solid #e5e5e5;border-radius:8px;font-size:13px}
  .modal .row{display:flex;gap:8px;margin-top:16px;justify-content:flex-end}
</style>
</head>
<body>

<div id="app">
  <div class="loading" style="padding:80px">Verificando autenticação…</div>
</div>

<div class="config-modal" id="configModal">
  <div class="modal">
    <h2>⚙️ Configurações</h2>
    <label>Período para média de vendas (dias)</label>
    <input type="number" id="inputPeriodo" value="30" min="7" max="365"/>
    <label>Estoque mínimo cobre quantos dias</label>
    <input type="number" id="inputMinDias" value="15" min="1" max="180"/>
    <div class="row">
      <button onclick="fecharConfig()">Cancelar</button>
      <button class="primary" onclick="salvarConfig()">Salvar</button>
    </div>
  </div>
</div>

<script>
let config = JSON.parse(localStorage.getItem('cfg2') || '{"periodo":30,"minDias":15}');
let dados = [];

async function init(){
  const r = await fetch('/auth/status');
  const s = await r.json();
  if(s.authenticated){
    renderPainel();
  } else {
    renderLogin();
  }
}

function renderLogin(){
  document.getElementById('app').innerHTML = \`
    <div class="login-screen">
      <div style="font-size:48px">📦</div>
      <h2>Controle de Estoque</h2>
      <p>Conecte sua conta Bling para visualizar estoque e previsão de vendas em tempo real.</p>
      <a href="/login"><button class="primary" style="padding:12px 28px;font-size:15px">Entrar com Bling</button></a>
    </div>
  \`;
}

function renderPainel(){
  document.getElementById('app').innerHTML = \`
    <header>
      <h1>📦 Controle de Estoque</h1>
      <div style="display:flex;gap:8px;align-items:center">
        <span id="lastSync" style="font-size:12px;color:#888"></span>
        <button onclick="syncDados()">🔄 Atualizar</button>
        <button onclick="abrirConfig()">⚙️ Config</button>
      </div>
    </header>
    <div class="cards">
      <div class="card"><div class="num" id="totalProd">—</div><div class="lbl">Total de Produtos</div></div>
      <div class="card critico"><div class="num" id="totalCritico">—</div><div class="lbl">Estoque Crítico</div></div>
      <div class="card atencao"><div class="num" id="totalAtencao">—</div><div class="lbl">Atenção</div></div>
      <div class="card ok"><div class="num" id="totalOk">—</div><div class="lbl">Estoque OK</div></div>
    </div>
    <div class="top-bar">
      <input type="text" id="busca" placeholder="Buscar SKU ou produto…" oninput="renderTabela()" style="width:220px"/>
      <select id="filtroStatus" onchange="renderTabela()">
        <option value="">Todos os status</option>
        <option value="critico">Crítico</option>
        <option value="atencao">Atenção</option>
        <option value="ok">OK</option>
      </select>
      <select id="filtroCategoria" onchange="renderTabela()">
        <option value="">Todas as categorias</option>
      </select>
      <label style="font-size:13px;color:#666;display:flex;align-items:center;gap:6px">
        <input type="checkbox" id="ocultarZero" onchange="renderTabela()"/>
        Ocultar sem vendas e sem estoque
      </label>
    </div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Status</th><th>SKU</th><th>Produto</th><th>Categoria</th>
            <th>Vendas 7d</th><th>Vendas Total</th><th>Média/dia</th>
            <th>Estoque</th><th>Est. Mínimo</th><th>Atinge Mínimo</th><th>Zera Estoque</th>
          </tr>
        </thead>
        <tbody id="tbody"><tr><td colspan="11" class="loading">Clique em Atualizar para carregar os dados</td></tr></tbody>
      </table>
    </div>
  \`;
}

function abrirConfig(){
  document.getElementById('inputPeriodo').value = config.periodo;
  document.getElementById('inputMinDias').value = config.minDias;
  document.getElementById('configModal').classList.add('open');
}
function fecharConfig(){ document.getElementById('configModal').classList.remove('open'); }
function salvarConfig(){
  config.periodo = parseInt(document.getElementById('inputPeriodo').value);
  config.minDias = parseInt(document.getElementById('inputMinDias').value);
  localStorage.setItem('cfg2', JSON.stringify(config));
  fecharConfig();
}
document.getElementById('configModal').addEventListener('click', e => { if(e.target===e.currentTarget) fecharConfig(); });

async function blingGet(path){
  const r = await fetch('/api/bling' + path);
  if(r.status === 401){ renderLogin(); throw new Error('Sessão expirada'); }
  return r.json();
}

async function syncDados(){
  const tbody = document.getElementById('tbody');
  if(!tbody) return;
  tbody.innerHTML = '<tr><td colspan="11" class="loading">Carregando produtos…</td></tr>';

  try {
    let produtos = [];
    let pagina = 1;
    while(true){
      const r = await blingGet('/produtos?pagina=' + pagina + '&limite=100&situacao=A');
      const items = r.data || [];
      produtos = produtos.concat(items);
      if(items.length < 100) break;
      pagina++;
      if(pagina > 30) break;
    }
    produtos = produtos.filter(p => p.codigo && String(p.codigo).startsWith('0'));

    tbody.innerHTML = '<tr><td colspan="11" class="loading">Carregando estoques… (' + produtos.length + ' produtos)</td></tr>';

    const estoqueMap = {};
    for(const p of produtos){
      try {
        const r = await blingGet('/estoques/' + p.id);
        const depositos = r.data?.depositos || r.data?.balances || [];
        let total = 0;
        for(const d of depositos) total += (d.saldoVirtual || d.saldo || 0);
        estoqueMap[p.id] = total;
      } catch { estoqueMap[p.id] = 0; }
    }

    tbody.innerHTML = '<tr><td colspan="11" class="loading">Carregando vendas…</td></tr>';
    const hoje = new Date();
    const dataFim = hoje.toISOString().split('T')[0];
    const dataIni = new Date(hoje - config.periodo * 86400000).toISOString().split('T')[0];

    let pedidos = [];
    pagina = 1;
    while(true){
      const r = await blingGet('/pedidos/vendas?dataInicial=' + dataIni + '&dataFinal=' + dataFim + '&situacao=6&pagina=' + pagina + '&limite=100');
      const items = r.data || [];
      pedidos = pedidos.concat(items);
      if(items.length < 100) break;
      pagina++;
      if(pagina > 20) break;
    }

    const vendasMap = {};
    const vendas7dMap = {};
    const corte7d = new Date(hoje - 7 * 86400000);
    for(const pedido of pedidos){
      for(const item of (pedido.itens || [])){
        const sku = item.produto?.codigo || '';
        if(!sku.startsWith('0')) continue;
        const id = item.produto?.id;
        if(!vendasMap[id]) vendasMap[id] = 0;
        if(!vendas7dMap[id]) vendas7dMap[id] = 0;
        vendasMap[id] += item.quantidade || 0;
        if(new Date(pedido.data) >= corte7d) vendas7dMap[id] += item.quantidade || 0;
      }
    }

    const categorias = new Set();
    dados = produtos.map(p => {
      const estoque = estoqueMap[p.id] || 0;
      const vendasTotal = vendasMap[p.id] || 0;
      const vendas7d = vendas7dMap[p.id] || 0;
      const mediaDia = vendasTotal / config.periodo;
      const estoqueMin = Math.ceil(mediaDia * config.minDias);
      const diasAteMin = mediaDia > 0 ? Math.floor((estoque - estoqueMin) / mediaDia) : 999;
      const diasAteZero = mediaDia > 0 ? Math.floor(estoque / mediaDia) : 999;
      const categoria = p.categoria?.descricao || '—';
      categorias.add(categoria);
      let status = 'ok';
      if(mediaDia > 0){
        if(estoque <= estoqueMin || diasAteZero <= 7) status = 'critico';
        else if(diasAteMin <= config.minDias) status = 'atencao';
      }
      const nome = p.descricao || p.nome || p.name || p.description || p.codigo || '—';
      return { id:p.id, sku:p.codigo, nome, categoria, vendas7d, vendasTotal, mediaDia, estoque, estoqueMin, diasAteMin, diasAteZero, status };
    });

    const sel = document.getElementById('filtroCategoria');
    sel.innerHTML = '<option value="">Todas as categorias</option>';
    for(const c of [...categorias].sort()) sel.innerHTML += '<option value="'+c+'">'+c+'</option>';

    document.getElementById('totalProd').textContent = dados.length;
    document.getElementById('totalCritico').textContent = dados.filter(d=>d.status==='critico').length;
    document.getElementById('totalAtencao').textContent = dados.filter(d=>d.status==='atencao').length;
    document.getElementById('totalOk').textContent = dados.filter(d=>d.status==='ok').length;
    document.getElementById('lastSync').textContent = 'Atualizado ' + new Date().toLocaleTimeString('pt-BR');

    renderTabela();
  } catch(err){
    if(document.getElementById('tbody'))
      document.getElementById('tbody').innerHTML = '<tr><td colspan="11" class="empty">Erro: ' + err.message + '</td></tr>';
  }
}

function renderTabela(){
  const busca = (document.getElementById('busca')?.value || '').toLowerCase();
  const filtroStatus = document.getElementById('filtroStatus')?.value || '';
  const filtroCategoria = document.getElementById('filtroCategoria')?.value || '';
  const ocultarZero = document.getElementById('ocultarZero')?.checked || false;

  let rows = dados.filter(d => {
    if(busca && !d.sku.toLowerCase().includes(busca) && !d.nome.toLowerCase().includes(busca)) return false;
    if(filtroStatus && d.status !== filtroStatus) return false;
    if(filtroCategoria && d.categoria !== filtroCategoria) return false;
    if(ocultarZero && d.vendasTotal === 0 && d.estoque === 0) return false;
    return true;
  });

  rows.sort((a,b) => {
    const ord = {critico:0,atencao:1,ok:2};
    if(ord[a.status] !== ord[b.status]) return ord[a.status] - ord[b.status];
    return a.diasAteZero - b.diasAteZero;
  });

  if(!rows.length){ document.getElementById('tbody').innerHTML = '<tr><td colspan="11" class="empty">Nenhum produto encontrado</td></tr>'; return; }

  const badgeStatus = {
    critico: '<span class="badge critico"><span class="dot"></span>Crítico</span>',
    atencao: '<span class="badge atencao"><span class="dot"></span>Atenção</span>',
    ok: '<span class="badge ok"><span class="dot"></span>OK</span>'
  };

  function diasBadge(dias){
    if(dias >= 999) return '<span style="color:#aaa;font-size:12px">—</span>';
    const cls = dias <= 7 ? 'r' : dias <= 30 ? 'a' : 'g';
    return '<span class="dias-badge '+cls+'">'+dias+'d</span>';
  }

  document.getElementById('tbody').innerHTML = rows.map(d => \`
    <tr>
      <td>\${badgeStatus[d.status]}</td>
      <td><span class="tag">\${d.sku}</span></td>
      <td style="max-width:220px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="\${d.nome}">\${d.nome}</td>
      <td style="color:#888">\${d.categoria}</td>
      <td style="text-align:right">\${d.vendas7d}</td>
      <td style="text-align:right">\${d.vendasTotal}</td>
      <td style="text-align:right">\${d.mediaDia > 0 ? d.mediaDia.toFixed(1) : '—'}</td>
      <td style="text-align:right;font-weight:500">\${d.estoque}</td>
      <td style="text-align:right;color:#888">\${d.estoqueMin > 0 ? d.estoqueMin : '—'}</td>
      <td>\${diasBadge(d.diasAteMin)}</td>
      <td>\${diasBadge(d.diasAteZero)}</td>
    </tr>
  \`).join('');
}

init();
</script>
</body>
</html>`;
