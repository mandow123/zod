const API = '/api';
const app = document.querySelector('#app');
const toastNode = document.querySelector('#toast');
const LEGACY_TOKEN_KEY = 'doujoy.web.token';
const TOKEN_KEY = 'kai.play.token';
const state = { token: localStorage.getItem(TOKEN_KEY) || localStorage.getItem(LEGACY_TOKEN_KEY), profile: null, view: 'lobby', game: null, room: null, history: null, selected: new Set(), busy: false, error: '' };

const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const money = value => new Intl.NumberFormat('zh-CN').format(value || 0);
const rank = n => ({3:'3',4:'4',5:'5',6:'6',7:'7',8:'8',9:'9',10:'10',11:'J',12:'Q',13:'K',14:'A',15:'2',16:'小王',17:'大王'}[n] || n);
const suit = s => ({spade:'♠',heart:'♥',club:'♣',diamond:'♦',joker:'★'}[s] || '');
const isRed = c => c.suit === 'heart' || c.suit === 'diamond';
const toast = msg => { toastNode.textContent = msg; toastNode.classList.add('show'); setTimeout(() => toastNode.classList.remove('show'), 2200); };
const requestId = () => globalThis.crypto?.randomUUID?.() || `web-${Date.now()}-${Math.random().toString(16).slice(2)}`;

async function api(path, options = {}) {
  const res = await fetch(`${API}${path}`, { ...options, headers: { 'content-type':'application/json', ...(state.token ? {'x-doujoy-token':state.token} : {}), ...options.headers } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) {
    const error = new Error(body?.error?.message || `请求失败（${res.status}）`);
    error.code = body?.error?.code || 'REQUEST_FAILED';
    throw error;
  }
  return body;
}

async function bootstrap() {
  try {
    if (state.token) {
      try { state.profile = (await api('/v1/me')).profile; }
      catch { state.token = null; localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(LEGACY_TOKEN_KEY); }
    }
    if (!state.token) {
      const session = await api('/v1/sessions/guest', {method:'POST', body:'{}'});
      state.token = session.token; state.profile = session.profile;
      localStorage.setItem(TOKEN_KEY, state.token);
    }
    const resumed = await api('/v1/resume');
    if (resumed.game) { state.game = resumed.game; state.view = 'game'; }
    else if (resumed.room) { state.room = resumed.room; state.view = 'room'; }
  } catch (e) { state.error = `无法连接后端：${e.message}`; }
  render();
}

function header() {
  const name = state.profile?.name || '正在登录';
  return `<header class="topbar"><button class="brand brand-button" data-view="lobby" aria-label="返回 KAI Play 大厅"><div class="logo"><span></span>K</div><div>KAI PLAY <small>算力游戏空间</small></div></button><div class="top-actions"><div class="player-chip"><span class="player-avatar">${esc(name.slice(0,1))}</span><span><b>${esc(name)}</b><small>${tierName(state.profile)}</small></span></div><div class="score-pill"><small>竞技分</small><strong>${money(competitiveScore(state.profile))}</strong></div></div></header>`;
}

function competitiveScore(profile) { return Math.max(0, Number(profile?.balance) || 0); }
function winRatePercent(profile) {
  const value = Math.max(0, Number(profile?.winRate) || 0);
  return Math.min(100, Math.round(value));
}
function tierName(profile) {
  const score = competitiveScore(profile);
  if (score >= 12000) return '星域段位';
  if (score >= 8000) return '跃迁段位';
  if (score >= 4000) return '巡航段位';
  return '启航段位';
}

function gameCard({kind, eyebrow, title, description, meta, action, tone, badge}) {
  const playable = action === 'quick';
  return `<article class="game-card ${tone} ${playable ? 'is-live' : 'is-preview'}">
    <div class="game-visual" aria-hidden="true"><span class="visual-grid"></span><b>${kind}</b><i></i></div>
    <div class="game-content"><div class="game-heading"><span class="eyebrow">${eyebrow}</span><span class="status-badge ${playable ? 'live' : ''}">${badge}</span></div>
      <h3>${title}</h3><p>${description}</p><div class="game-meta">${meta.map(item => `<span>${item}</span>`).join('')}</div>
      <button class="btn ${playable ? 'primary' : 'preview-button'}" data-action="${action}">${playable ? '立即开局' : '查看预告'} <b>→</b></button>
    </div></article>`;
}

function lobby() {
  const p = state.profile || {games:0,wins:0,winRate:0,name:'游客'};
  const games = [
    gameCard({kind:'3',eyebrow:'已开放',title:'三人争先',description:'三人牌局，抢先出完手牌。一个人也能与智能牌友立即开桌。',meta:['实时对局','好友同桌','公平牌序'],action:'quick',tone:'game-cyan',badge:'现在可玩'}),
    gameCard({kind:'将',eyebrow:'策略棋类',title:'KAI 象棋',description:'原创棋盘体验，规划加入棋力匹配、残局训练和算力复盘。',meta:['残局训练','AI 讲解'],action:'preview-xiangqi',tone:'game-orange',badge:'即将开放'}),
    gameCard({kind:'III',eyebrow:'轻量竞技',title:'三张竞技',description:'围绕三张牌型展开的积分回合赛，不使用现金下注或可提现筹码。',meta:['短局竞技','赛季积分'],action:'preview-three',tone:'game-violet',badge:'产品预览'}),
    gameCard({kind:'AI',eyebrow:'算力玩法',title:'AI 挑战场',description:'挑战不同思路与强度的 AI 对手，获得逐局生成的能力报告。',meta:['多难度','成长报告'],action:'preview-ai',tone:'game-green',badge:'即将开放'})
  ].join('');
  return `<div class="shell lobby-shell">${header()}${state.error ? `<div class="banner">${esc(state.error)}　游戏服务暂时离线，请稍后刷新。</div>`:''}
    <section class="kai-hero"><div class="kai-hero-copy"><span class="kicker"><i class="live-dot"></i> KAI 算力驱动</span><h1>玩一局，<br><em>看见策略。</em></h1><p>免费开局，轻松竞技。未来由 KAI 算力提供 AI 牌友、智能复盘与云端房间能力。</p><div class="actions"><button class="btn primary play-now" data-action="quick">进入三人争先 <b>→</b></button><button class="btn glass" data-action="resume">继续上次对局</button></div></div><div class="compute-orbit" aria-hidden="true"><div class="orbit orbit-a"></div><div class="orbit orbit-b"></div><div class="compute-core"><span>KAI</span><small>PLAY</small></div><div class="data-node node-a">♠</div><div class="data-node node-b">炮</div><div class="data-node node-c">AI</div></div></section>
    <section class="section-block"><div class="section-head"><div><span class="section-kicker">PLAYGROUND / 01</span><h2>选择你的下一局</h2></div><p>一套账号体验多种原创竞技玩法</p></div><div class="game-grid">${games}</div></section>
    <section class="dashboard-grid"><article class="card room-panel"><div><span class="section-kicker">FRIEND ROOM</span><h2>好友同桌</h2><p class="muted">创建六位房号分享给朋友，人数不足时可由智能牌友补位。</p></div><div class="room-actions"><button class="btn primary" data-action="create-room">＋ 创建房间</button><div class="friend-row"><input class="input" id="room-code" maxlength="6" inputmode="numeric" aria-label="六位房号" placeholder="输入 6 位房号"><button class="btn" data-action="join-room">加入</button></div></div></article>
    <article class="card player-panel"><div class="profile-line"><div class="player-avatar large">${esc((p.name||'玩').slice(0,1))}</div><div><span class="section-kicker">MY SEASON</span><h2>${tierName(p)}</h2></div></div><div class="stats"><div class="stat"><b>${competitiveScore(p)}</b><span>竞技分</span></div><div class="stat"><b>${p.games}</b><span>对局</span></div><div class="stat"><b>${winRatePercent(p)}%</b><span>胜率</span></div></div><button class="text-link" data-view="history">查看完整战绩 →</button></article></section>
    ${computeServices()}${nav('lobby')}</div>`;
}

function computeServices() {
  const services = [
    ['复盘','AI 复盘','逐手解释关键决策与替代路径'],
    ['对手','高级 AI','挑战更高强度与不同风格的智能对手'],
    ['云房','房间托管','云端保留房间与长期战绩']
  ];
  return `<section class="section-block service-section"><div class="section-head"><div><span class="section-kicker">COMPUTE SERVICES / 02</span><h2>把算力用在关键一手</h2></div><span class="cloudpay-tag">即将接入 CloudPay · KAI 卡时</span></div><div class="service-grid">${services.map(([icon,title,copy]) => `<button class="service-card" data-action="preview-cloudpay"><span>${icon}</span><div><b>${title}</b><small>${copy}</small></div><i>即将开放</i></button>`).join('')}</div><p class="service-note">普通对局始终免费。卡时未来只用于明确的 AI 与云端服务，不参与牌局输赢。</p></section>`;
}

function nav(active) { return `<nav class="nav"><button class="btn ${active==='lobby'?'active':''}" data-view="lobby">游戏</button><button class="btn ${active==='history'?'active':''}" data-view="history">战绩</button><button class="btn ${active==='rules'?'active':''}" data-view="rules">规则</button></nav>`; }

function room() {
  const r = state.room;
  if (!r) return lobby();
  const seats = [0,1,2].map(i => { const m=r.members[i]; return m ? `<div class="seat"><div class="avatar">${esc(m.name.slice(0,1))}</div><b>${esc(m.name)}${m.isYou?'（我）':''}</b><p class="muted">${m.id===r.hostId?'房主':'已加入'}</p></div>` : `<div class="seat empty"><div class="avatar">＋</div><b>等待加入</b><p>分享房号邀请好友</p></div>`; }).join('');
  return `<div class="shell">${header()}<div class="page-head"><button class="btn ghost" data-action="leave-room">← 退出</button><h1>三人争先 · 好友同桌</h1><button class="btn" data-action="refresh-room">刷新</button></div><section class="card"><p class="muted" style="text-align:center">邀请房号</p><div class="room-code">${esc(r.code)}</div><div class="actions" style="justify-content:center"><button class="btn gold" data-action="copy-room">复制房号</button></div><div class="seats" style="margin-top:24px">${seats}</div><div class="actions" style="justify-content:center;margin-top:24px">${r.isHost?`<button class="btn primary" data-action="start-room">${r.members.length===3?'三人开始':'智能牌友补位'}</button>`:'<span class="muted">等待房主开始游戏…</span>'}</div></section></div>`;
}

function poker(c, selectable = true) {
  const content = `<span>${rank(c.rank)}</span><small>${suit(c.suit)}</small>`;
  if (!selectable) return `<span class="poker ${isRed(c)?'red':''}" aria-hidden="true">${content}</span>`;
  return `<button class="poker ${isRed(c)?'red':''} ${state.selected.has(c.id)?'selected':''}" data-card="${esc(c.id)}">${content}</button>`;
}

function game() {
  const g=state.game; if(!g) return lobby();
  const viewer=g.players.find(p=>p.seat===g.viewerSeat) || g.players[0];
  const rivals=g.players.filter(p=>p.seat!==g.viewerSeat);
  const roleName=role=>role==='landlord'?'领队':role==='farmer'?'协作位':'定主位';
  const playerPod=(p,position)=>`<div class="player-pod ${position} ${p.seat===g.currentSeat?'turn':''}"><div class="pod-avatar">${esc(p.name.slice(0,1))}<span>${roleName(p.role)}</span></div><div class="pod-copy"><b>${esc(p.name)}</b><small>${p.isBot?'智能牌友':p.seat===g.viewerSeat?'我':'在线玩家'}</small></div><div class="pod-count"><b>${p.cardCount}</b><small>张</small></div></div>`;
  const lead=g.leadCards?.length?g.leadCards.map(c=>poker(c,false)).join(''):'<span class="table-prompt">等待出牌</span>';
  const canAct=g.currentSeat===g.viewerSeat;
  const disabled=canAct?'':'disabled';
  const actions=g.phase==='bidding' ? [0,1,2,3].map(n=>`<button class="btn table-action ${n===3?'gold':''}" data-bid="${n}" ${disabled}>${n===0?'让先':n+' 档'}</button>`).join('') : g.phase==='playing' ? `<button class="btn table-action ghost" data-action="pass" ${disabled}>略过</button><button class="btn table-action primary" data-action="play" ${disabled}>出牌</button>` : `<button class="btn table-action primary" data-action="finish">回到大厅</button>`;
  const result=g.settlement?`<div class="card result-card"><span class="kicker">本局战报</span><h2>${g.settlement.winner==='landlord'?'领队获胜':'协作方获胜'}</h2><p class="muted">竞技系数 ${g.settlement.multiplier} · 公平承诺 ${esc(g.fairness.commitment.slice(0,12))}…</p></div>`:'';
  const turnText = g.phase==='finished'?'本局已结束':g.currentSeat===g.viewerSeat?(g.phase==='bidding'?'轮到你定主位':'轮到你出牌'):'牌友正在思考';
  const remaining=Math.max(0,45-Math.floor((Date.now()-new Date(g.updatedAt).getTime())/1000));
  return `<div class="shell table"><header class="game-top"><div class="brand compact"><div class="logo"><span></span>K</div><div>KAI PLAY<small>三人争先</small></div></div><div class="round-state"><span>${turnText}</span><b>基础系数 ${g.baseStake} · 当前 ${Math.max(1,2**g.bombs)}</b></div><div class="score-pill compact-score"><small>竞技分</small><strong>${money(competitiveScore(state.profile))}</strong></div></header>${result}<section class="landscape-table"><div class="table-score"><b>基础 ${g.baseStake}</b><span>系数 ${Math.max(1,2**g.bombs)}</span></div>${playerPod(rivals[0]||viewer,'opponent-left')}${playerPod(rivals[1]||viewer,'opponent-right')}${playerPod(viewer,'viewer-pod')}${g.bottomCards?.length?`<div class="bottom-reveal"><small>增补牌</small>${g.bottomCards.map(c=>poker(c,false)).join('')}</div>`:''}<div class="play-zone"><div class="play-cards">${lead}</div><p>${g.lastEvent?`${esc(g.players.find(p=>p.seat===g.lastEvent.seat)?.name||'玩家')} ${g.lastEvent.kind==='pass'?'选择略过':'已出牌'}`:'牌局开始，祝你好运'}</p></div><div class="center-controls"><div class="turn-timer">${remaining}<small>秒</small></div><div class="game-actions">${actions}</div></div><footer class="hand-dock"><div class="hand">${g.hand.map(c=>poker(c,true)).join('')}</div><p>点击手牌选择 · 规则由服务端统一判定</p></footer></section></div>`;
}

function history() {
  const h=state.history;
  const games=h?.games?.length ? h.games.map(x=>`<div class="history-item"><div><span class="history-game">三人争先</span><b>${x.role==='landlord'?'领队':'协作位'} · ${x.winner==='landlord'?'领队胜':'协作方胜'}</b><small class="muted">${new Date(x.updatedAt).toLocaleString()} · 竞技系数 ${x.multiplier}</small></div><b class="${x.delta>=0?'positive':'negative'}">${x.delta>=0?'+':''}${x.delta}<small> 分</small></b></div>`).join('') : '<div class="empty-state">还没有完成对局，先去大厅玩一局三人争先吧。</div>';
  return `<div class="shell page-shell">${header()}<div class="section-head page-title"><div><span class="section-kicker">RECORD</span><h1>我的战绩</h1></div><div class="score-overview"><small>当前竞技分</small><strong>${money(competitiveScore(state.profile))}</strong></div></div><section class="card"><div class="history-list">${games}</div></section>${nav('history')}</div>`;
}

function rules() { return `<div class="shell page-shell">${header()}<div class="section-head page-title"><div><span class="section-kicker">FAIR PLAY</span><h1>规则与公平</h1></div><p>免费竞技，结果透明</p></div><section class="card"><div class="rules"><div class="rule"><span>01</span><div><h3>竞技分不是支付资产</h3><p class="muted">竞技分只用于段位、匹配与战绩展示，不可购买、提现、转让或兑换。</p></div></div><div class="rule"><span>02</span><div><h3>服务端统一判定</h3><p class="muted">发牌、定主位、牌型比较、回合与结算均由服务端执行，客户端不能指定结果。</p></div></div><div class="rule"><span>03</span><div><h3>牌序可以复核</h3><p class="muted">开局公布 SHA-256 承诺；结束后公开 nonce 与牌序，可核验对局过程中没有换牌。</p></div></div><div class="rule"><span>04</span><div><h3>卡时与输赢隔离</h3><p class="muted">未来 KAI 卡时仅用于明确的 AI 与云端服务，不会成为牌桌筹码，也不能通过对局赢取。</p></div></div></div></section>${nav('rules')}</div>`; }

function render() { app.innerHTML = state.view==='game'?game():state.view==='room'?room():state.view==='history'?history():state.view==='rules'?rules():lobby(); }

async function refreshProfile(){ state.profile=(await api('/v1/me')).profile; }
async function loadGame(id){ state.game=(await api(`/v1/games/${id}`)).game; state.view='game'; state.selected.clear(); render(); }
async function startQuickGame(){
  try {
    state.game=(await api('/v1/games/quick',{method:'POST',body:'{}'})).game;
  } catch (error) {
    if (error.code !== 'RELIEF_REQUIRED') throw error;
    const relief=await api('/v1/relief',{method:'POST',body:'{}'});
    state.profile=relief.profile;
    state.game=(await api('/v1/games/quick',{method:'POST',body:'{}'})).game;
    toast('已领取免费竞技分补给');
  }
  state.view='game';
}
async function act(fn){ if(state.busy)return; state.busy=true; try{await fn(); state.error='';}catch(e){toast(e.message);}finally{state.busy=false;render();} }

app.addEventListener('click', e => {
  const el=e.target.closest('button'); if(!el)return;
  if(el.dataset.card){ const id=el.dataset.card; state.selected.has(id)?state.selected.delete(id):state.selected.add(id); render(); return; }
  if(el.dataset.view){ state.view=el.dataset.view; if(state.view==='history') act(async()=>{state.history=await api('/v1/history');}); else render(); return; }
  if(el.dataset.bid!==undefined) act(async()=>{const body={score:Number(el.dataset.bid),expectedSequence:state.game.sequence};const r=await api(`/v1/games/${state.game.id}/bid`,{method:'POST',body:JSON.stringify(body),headers:{'x-request-id':requestId()}});state.game=r.game;state.profile=r.profile;});
  const a=el.dataset.action;
  if(a==='quick') act(startQuickGame);
  if(a==='resume') act(async()=>{const r=await api('/v1/resume');if(r.game){state.game=r.game;state.view='game';}else if(r.room){state.room=r.room;state.view='room';}else toast('没有待恢复的牌局');});
  if(a==='create-room') act(async()=>{state.room=(await api('/v1/rooms',{method:'POST',body:'{}'})).room;state.view='room';});
  if(a==='join-room') act(async()=>{const code=document.querySelector('#room-code')?.value.trim();if(!/^\d{6}$/.test(code))throw new Error('请输入 6 位房号');state.room=(await api('/v1/rooms/join',{method:'POST',body:JSON.stringify({code})})).room;state.view='room';});
  if(a==='copy-room') {
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(state.room.code).then(()=>toast('房号已复制')).catch(()=>toast(`房号：${state.room.code}`));
    else toast(`房号：${state.room.code}`);
  }
  if(a==='refresh-room') act(async()=>{state.room=(await api(`/v1/rooms/${state.room.id}`)).room;if(state.room.gameId)await loadGame(state.room.gameId);});
  if(a==='start-room') act(async()=>{const r=await api(`/v1/rooms/${state.room.id}/start`,{method:'POST',body:'{}'});state.room=r.room;state.game=r.game;state.view='game';});
  if(a==='leave-room') act(async()=>{await api(`/v1/rooms/${state.room.id}/leave`,{method:'POST',body:'{}'});state.room=null;state.view='lobby';});
  if(a==='pass') act(async()=>{const r=await api(`/v1/games/${state.game.id}/pass`,{method:'POST',body:JSON.stringify({expectedSequence:state.game.sequence}),headers:{'x-request-id':requestId()}});state.game=r.game;state.profile=r.profile;});
  if(a==='play') act(async()=>{if(!state.selected.size)throw new Error('请先选择要出的牌');const r=await api(`/v1/games/${state.game.id}/play`,{method:'POST',body:JSON.stringify({cardIds:[...state.selected],expectedSequence:state.game.sequence}),headers:{'x-request-id':requestId()}});state.game=r.game;state.profile=r.profile;state.selected.clear();});
  if(a==='finish') act(async()=>{await refreshProfile();state.game=null;state.view='lobby';});
  if(a?.startsWith('preview-')) {
    const messages = {
      'preview-xiangqi':'KAI 象棋正在设计中，当前页面只展示产品方向。',
      'preview-three':'三张竞技尚未开放，不包含现金下注或可提现筹码。',
      'preview-ai':'AI 挑战场即将开放，当前不会产生任何费用。',
      'preview-cloudpay':'该服务即将接入 CloudPay，目前没有支付或扣除卡时。'
    };
    toast(messages[a] || '该能力即将开放');
  }
});

bootstrap();
setInterval(() => {
  if (state.view === 'game' && state.game && state.game.phase !== 'finished') render();
}, 1000);
