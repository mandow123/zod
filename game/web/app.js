const API = '/api';
const app = document.querySelector('#app');
const toastNode = document.querySelector('#toast');
const state = { token: localStorage.getItem('doujoy.web.token'), profile: null, view: 'lobby', game: null, room: null, history: null, selected: new Set(), busy: false, error: '' };

const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const money = value => new Intl.NumberFormat('zh-CN').format(value || 0);
const rank = n => ({3:'3',4:'4',5:'5',6:'6',7:'7',8:'8',9:'9',10:'10',11:'J',12:'Q',13:'K',14:'A',15:'2',16:'小王',17:'大王'}[n] || n);
const suit = s => ({spade:'♠',heart:'♥',club:'♣',diamond:'♦',joker:'★'}[s] || '');
const isRed = c => c.suit === 'heart' || c.suit === 'diamond';
const toast = msg => { toastNode.textContent = msg; toastNode.classList.add('show'); setTimeout(() => toastNode.classList.remove('show'), 2200); };

async function api(path, options = {}) {
  const res = await fetch(`${API}${path}`, { ...options, headers: { 'content-type':'application/json', ...(state.token ? {authorization:`Bearer ${state.token}`} : {}), ...options.headers } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) throw new Error(body?.error?.message || `请求失败（${res.status}）`);
  return body;
}

async function bootstrap() {
  try {
    if (state.token) {
      try { state.profile = (await api('/v1/me')).profile; }
      catch { state.token = null; localStorage.removeItem('doujoy.web.token'); }
    }
    if (!state.token) {
      const session = await api('/v1/sessions/guest', {method:'POST', body:'{}'});
      state.token = session.token; state.profile = session.profile;
      localStorage.setItem('doujoy.web.token', state.token);
    }
    const resumed = await api('/v1/resume');
    if (resumed.game) { state.game = resumed.game; state.view = 'game'; }
    else if (resumed.room) { state.room = resumed.room; state.view = 'room'; }
  } catch (e) { state.error = `无法连接后端：${e.message}`; }
  render();
}

function header() {
  const name = state.profile?.name || '正在登录';
  return `<header class="topbar"><div class="brand"><div class="logo">豆</div><div>豆局 <small>DOUJOY</small></div></div><div class="top-actions"><div class="player-chip"><span class="player-avatar">${esc(name.slice(0,1))}</span><span><b>${esc(name)}</b><small>内部体验玩家</small></span></div><div class="balance"><i></i><span>${money(state.profile?.balance)}</span> 欢乐豆</div></div></header>`;
}

function lobby() {
  const p = state.profile || {games:0,wins:0,winRate:0,name:'游客'};
  return `<div class="shell lobby-shell">${header()}${state.error ? `<div class="banner">${esc(state.error)}　界面代理暂未连接到游戏服务，请刷新重试。</div>`:''}<div class="grid"><section class="card hero"><div class="hero-copy"><span class="kicker"><i class="live-dot"></i> 服务端秒开 · 公平洗牌</span><h1>三分钟，<br>来一局。</h1><p>一人立即开局，两名智能牌友随时就位；也可以邀请朋友，用六位房号坐上同一张牌桌。</p><div class="hero-meta"><span>经典规则</span><span>45 秒托管</span><span>牌序可复核</span></div><div class="actions"><button class="btn primary play-now" data-action="quick">立即开局 <b>→</b></button><button class="btn ghost" data-action="resume">恢复上局</button></div></div><div class="hero-art" aria-hidden="true"><div class="hero-halo"></div><div class="bean-orb">豆</div><div class="hero-poker card-a">A<small>♠</small></div><div class="hero-poker card-k">K<small>♥</small></div><div class="hero-poker card-joker">王<small>★</small></div><span class="spark spark-one">✦</span><span class="spark spark-two">✦</span></div></section><aside class="card friend-card"><div class="mode-icon">♣</div><span class="eyebrow">好友同玩</span><h2 class="section-title">六位房号，随时开桌</h2><p class="muted">创建房间分享给朋友；三人到齐直接开始，人数不足也可以让机器人补位。</p><button class="btn accent" data-action="create-room">＋ 创建好友房</button><div class="friend-row"><input class="input" id="room-code" maxlength="6" inputmode="numeric" placeholder="输入 6 位房号"><button class="btn" data-action="join-room">加入</button></div><div class="stats"><div class="stat"><b>${p.games}</b><span>已玩</span></div><div class="stat"><b>${Math.round((p.winRate||0)*100)}%</b><span>胜率</span></div><div class="stat"><b>${p.wins}</b><span>获胜</span></div></div></aside></div><section class="mode-strip"><button class="mini-mode classic" data-action="quick"><span class="mini-icon">♠</span><span><b>经典场</b><small>一键匹配机器人</small></span><strong>开始</strong></button><button class="mini-mode friends" data-action="create-room"><span class="mini-icon">♦</span><span><b>好友场</b><small>真人房号对局</small></span><strong>创建</strong></button><button class="mini-mode fair" data-view="rules"><span class="mini-icon">✓</span><span><b>公平说明</b><small>规则与牌序验证</small></span><strong>查看</strong></button></section>${nav('lobby')}</div>`;
}

function nav(active) { return `<nav class="nav"><button class="btn ${active==='lobby'?'active':''}" data-view="lobby">大厅</button><button class="btn ${active==='history'?'active':''}" data-view="history">战绩</button><button class="btn ${active==='rules'?'active':''}" data-view="rules">规则</button></nav>`; }

function room() {
  const r = state.room;
  if (!r) return lobby();
  const seats = [0,1,2].map(i => { const m=r.members[i]; return m ? `<div class="seat"><div class="avatar">${esc(m.name.slice(0,1))}</div><b>${esc(m.name)}${m.isYou?'（我）':''}</b><p class="muted">${m.id===r.hostId?'房主':'已加入'}</p></div>` : `<div class="seat empty"><div class="avatar">＋</div><b>等待加入</b><p>分享房号邀请好友</p></div>`; }).join('');
  return `<div class="shell"><div class="page-head"><button class="btn ghost" data-action="leave-room">← 退出</button><h1>好友房</h1><button class="btn" data-action="refresh-room">刷新</button></div><section class="card"><p class="muted" style="text-align:center">房间号</p><div class="room-code">${esc(r.code)}</div><div class="actions" style="justify-content:center"><button class="btn gold" data-action="copy-room">复制房号</button></div><div class="seats" style="margin-top:24px">${seats}</div><div class="actions" style="justify-content:center;margin-top:24px">${r.isHost?`<button class="btn primary" data-action="start-room">${r.members.length===3?'三人开始':'机器人补位开始'}</button>`:'<span class="muted">等待房主开始游戏…</span>'}</div></section></div>`;
}

function poker(c, selectable = true) { return `<button class="poker ${isRed(c)?'red':''} ${selectable&&state.selected.has(c.id)?'selected':''}" ${selectable?`data-card="${esc(c.id)}"`: 'tabindex="-1" aria-hidden="true"'}><span>${rank(c.rank)}</span><small>${suit(c.suit)}</small></button>`; }

function game() {
  const g=state.game; if(!g) return lobby();
  const viewer=g.players.find(p=>p.seat===g.viewerSeat) || g.players[0];
  const rivals=g.players.filter(p=>p.seat!==g.viewerSeat);
  const playerPod=(p,position)=>`<div class="player-pod ${position} ${p.seat===g.currentSeat?'turn':''}"><div class="pod-avatar">${esc(p.name.slice(0,1))}<span>${p.role==='landlord'?'地主':p.role==='farmer'?'农民':'叫分'}</span></div><div class="pod-copy"><b>${esc(p.name)}</b><small>${p.isBot?'智能牌友':p.seat===g.viewerSeat?'我':'真人玩家'}</small></div><div class="pod-count"><b>${p.cardCount}</b><small>张</small></div></div>`;
  const lead=g.leadCards?.length?g.leadCards.map(c=>poker(c,false)).join(''):'<span class="table-prompt">等待出牌</span>';
  const canAct=g.currentSeat===g.viewerSeat;
  const disabled=canAct?'':'disabled';
  const actions=g.phase==='bidding' ? [0,1,2,3].map(n=>`<button class="btn table-action ${n===3?'gold':''}" data-bid="${n}" ${disabled}>${n===0?'不叫':n+' 分'}</button>`).join('') : g.phase==='playing' ? `<button class="btn table-action ghost" data-action="pass" ${disabled}>不出</button><button class="btn table-action primary" data-action="play" ${disabled}>出牌</button>` : `<button class="btn table-action primary" data-action="finish">回到大厅</button>`;
  const result=g.settlement?`<div class="card" style="text-align:center;margin-bottom:14px"><span class="kicker">本局结算</span><h2>${g.settlement.winner==='landlord'?'地主获胜':'农民获胜'}</h2><p class="muted">${g.settlement.multiplier} 倍 · 公平承诺 ${esc(g.fairness.commitment.slice(0,12))}…</p></div>`:'';
  const turnText = g.phase==='finished'?'本局已结束':g.currentSeat===g.viewerSeat?(g.phase==='bidding'?'轮到你叫分':'轮到你出牌'):'牌友正在思考';
  const remaining=Math.max(0,45-Math.floor((Date.now()-new Date(g.updatedAt).getTime())/1000));
  return `<div class="shell table"><header class="game-top"><div class="brand compact"><div class="logo">豆</div><div>豆局</div></div><div class="round-state"><span>${turnText}</span><b>底分 ${g.baseStake} · ${Math.max(1,2**g.bombs)} 倍</b></div><div class="balance"><i></i><span>${money(state.profile?.balance)}</span></div></header>${result}<section class="landscape-table"><div class="table-score"><b>底分 ${g.baseStake}</b><span>倍数 ${Math.max(1,2**g.bombs)}</span></div>${playerPod(rivals[0]||viewer,'opponent-left')}${playerPod(rivals[1]||viewer,'opponent-right')}${playerPod(viewer,'viewer-pod')}${g.bottomCards?.length?`<div class="bottom-reveal"><small>底牌</small>${g.bottomCards.map(c=>poker(c,false)).join('')}</div>`:''}<div class="play-zone"><div class="play-cards">${lead}</div><p>${g.lastEvent?`${esc(g.players.find(p=>p.seat===g.lastEvent.seat)?.name||'玩家')} ${g.lastEvent.kind==='pass'?'选择不出':'已出牌'}`:'牌局开始，祝你好运'}</p></div><div class="center-controls"><div class="turn-timer">${remaining}<small>秒</small></div><div class="game-actions">${actions}</div></div><footer class="hand-dock"><div class="hand">${g.hand.map(c=>poker(c,true)).join('')}</div><p>点击手牌选择 · 服务端校验牌型</p></footer></section></div>`;
}

function history() {
  const h=state.history;
  const games=h?.games?.length ? h.games.map(x=>`<div class="history-item"><div><b>${x.role==='landlord'?'地主':'农民'} · ${x.winner==='landlord'?'地主胜':'农民胜'}</b><br><small class="muted">${new Date(x.updatedAt).toLocaleString()} · ${x.multiplier} 倍</small></div><b class="${x.delta>=0?'positive':'negative'}">${x.delta>=0?'+':''}${x.delta}</b></div>`).join('') : '<div class="empty-state">还没有完成牌局，先去大厅开一局吧。</div>';
  return `<div class="shell">${header()}<section class="card"><h1>战绩与账本</h1><div class="history-list">${games}</div></section>${nav('history')}</div>`;
}

function rules() { return `<div class="shell">${header()}<section class="card"><h1>规则与公平</h1><div class="rules"><div class="rule"><h3>欢乐豆没有现金价值</h3><p class="muted">不可购买、不可提现、不可转让、不可兑换，只用于娱乐记分。</p></div><div class="rule"><h3>服务端权威判定</h3><p class="muted">发牌、叫分、牌型比较、回合与结算都由服务端执行，客户端不能指定结果。</p></div><div class="rule"><h3>牌序承诺</h3><p class="muted">开局公布 SHA-256 承诺；结束后公开 nonce 与牌序，可验证对局中没有换牌。</p></div><div class="rule"><h3>内部灰度说明</h3><p class="muted">当前版本用于少量受控用户体验。身份、并发、备份和房号防枚举仍会继续加强。</p></div></div></section>${nav('rules')}</div>`; }

function render() { app.innerHTML = state.view==='game'?game():state.view==='room'?room():state.view==='history'?history():state.view==='rules'?rules():lobby(); }

async function refreshProfile(){ state.profile=(await api('/v1/me')).profile; }
async function loadGame(id){ state.game=(await api(`/v1/games/${id}`)).game; state.view='game'; state.selected.clear(); render(); }
async function act(fn){ if(state.busy)return; state.busy=true; try{await fn(); state.error='';}catch(e){toast(e.message);}finally{state.busy=false;render();} }

app.addEventListener('click', e => {
  const el=e.target.closest('button'); if(!el)return;
  if(el.dataset.card){ const id=el.dataset.card; state.selected.has(id)?state.selected.delete(id):state.selected.add(id); render(); return; }
  if(el.dataset.view){ state.view=el.dataset.view; if(state.view==='history') act(async()=>{state.history=await api('/v1/history');}); else render(); return; }
  if(el.dataset.bid!==undefined) act(async()=>{const body={score:Number(el.dataset.bid),expectedSequence:state.game.sequence};const r=await api(`/v1/games/${state.game.id}/bid`,{method:'POST',body:JSON.stringify(body),headers:{'x-request-id':crypto.randomUUID()}});state.game=r.game;state.profile=r.profile;});
  const a=el.dataset.action;
  if(a==='quick') act(async()=>{state.game=(await api('/v1/games/quick',{method:'POST',body:'{}'})).game;state.view='game';});
  if(a==='resume') act(async()=>{const r=await api('/v1/resume');if(r.game){state.game=r.game;state.view='game';}else if(r.room){state.room=r.room;state.view='room';}else toast('没有待恢复的牌局');});
  if(a==='create-room') act(async()=>{state.room=(await api('/v1/rooms',{method:'POST',body:'{}'})).room;state.view='room';});
  if(a==='join-room') act(async()=>{const code=document.querySelector('#room-code')?.value.trim();if(!/^\d{6}$/.test(code))throw new Error('请输入 6 位房号');state.room=(await api('/v1/rooms/join',{method:'POST',body:JSON.stringify({code})})).room;state.view='room';});
  if(a==='copy-room') navigator.clipboard.writeText(state.room.code).then(()=>toast('房号已复制'));
  if(a==='refresh-room') act(async()=>{state.room=(await api(`/v1/rooms/${state.room.id}`)).room;if(state.room.gameId)await loadGame(state.room.gameId);});
  if(a==='start-room') act(async()=>{const r=await api(`/v1/rooms/${state.room.id}/start`,{method:'POST',body:'{}'});state.room=r.room;state.game=r.game;state.view='game';});
  if(a==='leave-room') act(async()=>{await api(`/v1/rooms/${state.room.id}/leave`,{method:'POST',body:'{}'});state.room=null;state.view='lobby';});
  if(a==='pass') act(async()=>{const r=await api(`/v1/games/${state.game.id}/pass`,{method:'POST',body:JSON.stringify({expectedSequence:state.game.sequence}),headers:{'x-request-id':crypto.randomUUID()}});state.game=r.game;state.profile=r.profile;});
  if(a==='play') act(async()=>{if(!state.selected.size)throw new Error('请先选择要出的牌');const r=await api(`/v1/games/${state.game.id}/play`,{method:'POST',body:JSON.stringify({cardIds:[...state.selected],expectedSequence:state.game.sequence}),headers:{'x-request-id':crypto.randomUUID()}});state.game=r.game;state.profile=r.profile;state.selected.clear();});
  if(a==='finish') act(async()=>{await refreshProfile();state.game=null;state.view='lobby';});
});

bootstrap();
setInterval(() => {
  if (state.view === 'game' && state.game && state.game.phase !== 'finished') render();
}, 1000);
