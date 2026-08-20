import { compareThreeCard, evaluateThreeCard, isWinningMahjong, newMahjongRound, newThreeCardRound, sortMahjong, spinSlots } from './casual-games.js';

const API = '/api';
const app = document.querySelector('#app');
const toastNode = document.querySelector('#toast');
const LEGACY_TOKEN_KEY = 'doujoy.web.token';
const TOKEN_KEY = 'kai.play.token';
const TURN_TIMEOUT_MS = 45_000;
const DEAL_ANIMATION_MS = 3_750;
const state = { token: localStorage.getItem(TOKEN_KEY) || localStorage.getItem(LEGACY_TOKEN_KEY), profile: null, view: 'lobby', game: null, room: null, history: null, selected: new Set(), busy: false, error: '', dealingGameId: null, dealTimer: null, waitController: null, exitConfirm: false, casual: null };

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
    if (resumed.game) enterGame(resumed.game);
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
  const playable = ['quick', 'open-three', 'open-mahjong', 'open-slots'].includes(action);
  return `<article class="game-card ${tone} ${playable ? 'is-live' : 'is-preview'}">
    ${gameVisual(action, kind)}
    <div class="game-content"><div class="game-heading"><span class="eyebrow">${eyebrow}</span><span class="status-badge ${playable ? 'live' : ''}">${badge}</span></div>
      <h3>${title}</h3><p>${description}</p><div class="game-meta">${meta.map(item => `<span>${item}</span>`).join('')}</div>
      <button class="btn ${playable ? 'primary' : 'preview-button'}" data-action="${action}">${playable ? '现在就玩' : '查看预告'} <b>→</b></button>
    </div></article>`;
}

function gameVisual(action, fallback) {
  const scenes = {
    quick: `<span class="visual-live"><i></i>三人实时桌</span><div class="visual-poker-fan"><i>J<small>♠</small></i><i>Q<small>♥</small></i><i>K<small>♣</small></i></div><b>斗地主</b>`,
    'open-three': `<span class="visual-live"><i></i>免费训练</span><div class="visual-three-cards"><i>9<small>♦</small></i><i>9<small>♣</small></i><i>A<small>♥</small></i></div><b>三张定胜负</b>`,
    'open-mahjong': `<span class="visual-live"><i></i>136 张牌墙</span><div class="visual-mahjong-tiles"><i>一<small>万</small></i><i>發</i><i>●<small>筒</small></i><i>三<small>条</small></i></div><b>摸一张 · 打一张</b>`,
    'open-slots': `<span class="visual-live"><i></i>零消耗娱乐</span><div class="visual-mini-reels"><i>7</i><i>KAI</i><i>⚡</i></div><b>转出你的组合</b>`,
  };
  return `<div class="game-visual visual-${action}" aria-hidden="true"><span class="visual-glow"></span>${scenes[action] || `<strong>${fallback}</strong>`}</div>`;
}

function lobby() {
  const p = state.profile || {games:0,wins:0,winRate:0,name:'游客'};
  const games = [
    gameCard({kind:'斗',eyebrow:'实时牌局',title:'斗地主',description:'经典三人出牌体验，与两位智能牌友对局，也可以邀请好友同桌。',meta:['服务端判定','好友房','公平牌序'],action:'quick',tone:'game-green',badge:'现在可玩'}),
    gameCard({kind:'三',eyebrow:'免费训练',title:'炸金花',description:'三张牌快速比大小，体验看牌、比牌与三人揭晓，不使用现金筹码。',meta:['单局 30 秒','两位 AI','不计积分'],action:'open-three',tone:'game-violet',badge:'试玩开放'}),
    gameCard({kind:'麻',eyebrow:'单人练习',title:'麻将',description:'完整 136 张牌墙，练习摸牌、打牌与四组面子加一对将的胡牌结构。',meta:['真实牌墙','胡牌检测','不计积分'],action:'open-mahjong',tone:'game-orange',badge:'试玩开放'}),
    gameCard({kind:'KAI',eyebrow:'轻量娱乐',title:'算力老虎机',description:'按一次让三个转轮停下：三枚相同是三连共振，两枚相同是双核同频。',meta:['规则清晰','免费旋转','无付费下注'],action:'open-slots',tone:'game-cyan',badge:'试玩开放'})
  ].join('');
  return `<div class="shell lobby-shell">${header()}${state.error ? `<div class="banner">${esc(state.error)}　游戏服务暂时离线，请稍后刷新。</div>`:''}
    <section class="kai-hero"><div class="kai-hero-copy"><span class="kicker"><i class="live-dot"></i> 4 款游戏现在可玩</span><h1>今晚，<br><em>开一局。</em></h1><p>斗地主和两位智能牌友实时过招，也可以轻松玩炸金花、麻将训练与免费转轮。没有充值诱导，点开就玩。</p><div class="hero-points"><span>真人思考时间</span><span>智能牌友</span><span>手机可玩</span></div><div class="actions"><button class="btn primary play-now" data-action="quick">快速开一桌 <b>→</b></button><button class="btn glass" data-action="scroll-games">看看其他游戏</button></div></div><div class="hero-game-stage" aria-hidden="true"><span class="hero-stage-label"><i></i>斗地主 · 三人桌</span><div class="hero-seat hero-seat-left">阿</div><div class="hero-seat hero-seat-right">禾</div><div class="hero-card-fan"><i>J<small>♠</small></i><i>Q<small>♥</small></i><i>K<small>♣</small></i><i class="hero-joker">JOKER</i></div><div class="hero-turn"><b>15</b><span>思考中</span></div><div class="hero-mode-dock"><span><i>三</i>炸金花</span><span><i>麻</i>麻将</span><span><i>7</i>转轮</span></div></div></section>
    <section class="section-block" id="game-selection"><div class="section-head"><div><span class="section-kicker">PLAYGROUND / 01</span><h2>想玩什么，直接开局</h2></div><p>四个入口都能直接开始，试玩场不计竞技分</p></div><div class="game-grid">${games}</div></section>
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
  return `<div class="shell">${header()}<div class="page-head"><button class="btn ghost" data-action="leave-room">← 退出</button><h1>斗地主 · 好友同桌</h1><button class="btn" data-action="refresh-room">刷新</button></div><section class="card"><p class="muted" style="text-align:center">邀请房号</p><div class="room-code">${esc(r.code)}</div><div class="actions" style="justify-content:center"><button class="btn gold" data-action="copy-room">复制房号</button></div><div class="seats" style="margin-top:24px">${seats}</div><div class="actions" style="justify-content:center;margin-top:24px">${r.isHost?`<button class="btn primary" data-action="start-room">${r.members.length===3?'三人开始':'智能牌友补位'}</button>`:'<span class="muted">等待房主开始游戏…</span>'}</div></section></div>`;
}

function poker(c, selectable = true) {
  const rawLabel = rank(c.rank);
  const symbol = suit(c.suit);
  const joker = c.suit === 'joker';
  const bigJoker = joker && c.rank === 17;
  const classes = [isRed(c)?'red':'', joker?'joker-card':'', joker?(bigJoker?'joker-red':'joker-gray'):''].filter(Boolean).join(' ');
  const content = joker
    ? `<span class="joker-index">${bigJoker?'大王':'小王'}</span><i class="joker-face"><em>${bigJoker?'RED':'GREY'}</em><b>JOKER</b><strong>♛</strong></i>`
    : `<span class="card-index"><b>${rawLabel}</b><small>${symbol}</small></span>${[11,12,13].includes(c.rank)
      ? `<i class="card-court face-${String(rawLabel).toLowerCase()}"><em>${rawLabel}</em><b>${symbol}</b><strong>KAI</strong></i>`
      : `<i class="card-pip">${symbol}</i>`}`;
  const aria = joker ? `${bigJoker?'大王':'小王'} ${bigJoker?'红色':'灰色'} JOKER` : `${rawLabel}${symbol}`;
  if (!selectable) return `<span class="poker ${classes}" aria-hidden="true">${content}</span>`;
  return `<button class="poker ${classes} ${state.selected.has(c.id)?'selected':''}" data-card="${esc(c.id)}" aria-label="${esc(aria)}">${content}</button>`;
}

function turnRemaining(g) {
  const deadline = Date.parse(g?.turn?.deadline || '');
  const fallback = Date.parse(g?.updatedAt || '') + TURN_TIMEOUT_MS;
  const effectiveDeadline = Number.isFinite(deadline) ? deadline : fallback;
  if (!Number.isFinite(effectiveDeadline) || g?.phase === 'finished') return 0;
  return Math.max(0, Math.ceil((effectiveDeadline - Date.now()) / 1000));
}

function dealSequence() {
  const flights = Array.from({length: 51}, (_, index) => `<i class="deal-card deal-seat-${index % 3}" style="--deal-index:${index}" aria-hidden="true"></i>`).join('');
  const target = (position, label) => `<div class="deal-target ${position}" aria-hidden="true"><span><i></i><i></i><i></i></span><b>${label}</b><small>17 张</small></div>`;
  return `<div class="deal-sequence" role="status" aria-live="polite" aria-label="开局发牌中，每位玩家十七张，预留三张增补牌">
    <div class="deal-copy"><span>开局发牌</span><b>正在依次发给三位玩家</b><small>每人 17 张 · 预留 3 张增补牌</small><ol><li>准备牌组</li><li>安全发牌</li><li>牌局锁定</li></ol></div>
    ${target('target-left','左侧牌友')}${target('target-right','右侧牌友')}${target('target-bottom','你的手牌')}
    <div class="deal-deck" aria-hidden="true"><i></i><i></i><i></i><b>3</b><small>增补牌</small></div>${flights}
  </div>`;
}

function turnFeedback(g, canAct) {
  const remaining = turnRemaining(g);
  const current = g.players.find(player => player.seat === g.currentSeat);
  const botTurn = g.turn?.kind === 'bot' || current?.isBot;
  const durationSeconds = Math.max(1, Math.ceil((g.turn?.durationMs || TURN_TIMEOUT_MS) / 1000));
  const urgent = !botTurn && remaining <= 10;
  const progress = Math.min(360, Math.round((remaining / durationSeconds) * 360));
  const title = canAct ? '你的思考时间' : `${current?.name || '牌友'}正在思考`;
  const detail = remaining > 0
    ? (canAct ? '请在倒计时结束前完成操作' : botTurn ? `预计 ${remaining} 秒内行动` : '对方操作后牌桌会自动同步')
    : '时间到，服务端正在自动托管';
  return `<div class="turn-feedback ${canAct?'is-mine':'is-waiting'} ${botTurn?'is-bot':''} ${urgent?'is-urgent':''}" role="timer" aria-live="${urgent?'polite':'off'}" aria-label="${esc(title)}，${remaining > 0 ? `剩余 ${remaining} 秒` : detail}">
    <div class="turn-timer" style="--turn-progress:${progress}deg"><strong>${remaining || '··'}</strong><small>${remaining ? '秒' : '托管'}</small></div>
    <div class="turn-copy"><b>${esc(title)}${botTurn?'<span class="thinking-dots"><i></i><i></i><i></i></span>':''}</b><small>${detail}</small></div>
  </div>`;
}

function actionTrail(g) {
  const events = (g.recentEvents || []).slice(-3);
  if (!events.length) return '<p>牌局开始，祝你好运</p>';
  return `<div class="action-trail" aria-label="最近行动">${events.map(event => {
    const player = g.players.find(candidate => candidate.seat === event.seat);
    const cards = (event.cards || []).map(card => `${rank(card.rank)}${suit(card.suit)}`);
    const summary = event.kind === 'pass' ? '略过' : `${cards.slice(0,4).join(' ')}${cards.length>4?` +${cards.length-4}`:''}`;
    return `<span class="${event.seat===g.currentSeat?'current':''}"><b>${esc(player?.name || '玩家')}</b>${esc(summary || '已出牌')}</span>`;
  }).join('<i>→</i>')}</div>`;
}

function game() {
  const g=state.game; if(!g) return lobby();
  const isDealing=state.dealingGameId===g.id;
  const viewer=g.players.find(p=>p.seat===g.viewerSeat) || g.players[0];
  const rivals=g.players.filter(p=>p.seat!==g.viewerSeat);
  const roleName=role=>role==='landlord'?'领队':role==='farmer'?'协作位':'定主位';
  const playerPod=(p,position)=>`<div class="player-pod ${position} ${p.seat===g.currentSeat?'turn':''}"><div class="pod-avatar">${esc(p.name.slice(0,1))}<span>${roleName(p.role)}</span></div><div class="pod-copy"><b>${esc(p.name)}</b><small>${p.isBot?'智能牌友':p.seat===g.viewerSeat?'我':'在线玩家'}</small></div><div class="pod-count"><b>${p.cardCount}</b><small>张</small></div></div>`;
  const lead=g.leadCards?.length?g.leadCards.map(c=>poker(c,false)).join(''):'<span class="table-prompt">等待出牌</span>';
  const viewerTurn=g.currentSeat===g.viewerSeat;
  const canAct=!isDealing&&viewerTurn;
  const disabled=canAct?'':'disabled';
  const actions=g.phase==='bidding' ? [0,1,2,3].map(n=>`<button class="btn table-action ${n===3?'gold':''}" data-bid="${n}" ${disabled}>${n===0?'让先':n+' 档'}</button>`).join('') : g.phase==='playing' ? `<button class="btn table-action ghost" data-action="pass" ${disabled}>略过</button><button class="btn table-action primary" data-action="play" ${disabled}>出牌</button>` : `<button class="btn table-action primary" data-action="finish">回到大厅</button>`;
  const result=g.settlement?`<div class="card result-card"><span class="kicker">本局战报</span><h2>${g.settlement.winner==='landlord'?'领队获胜':'协作方获胜'}</h2><p class="muted">竞技系数 ${g.settlement.multiplier} · 公平承诺 ${esc(g.fairness.commitment.slice(0,12))}…</p></div>`:'';
  const currentPlayer=g.players.find(p=>p.seat===g.currentSeat);
  const turnText = isDealing?'正在依次发牌':g.phase==='finished'?'本局已结束':viewerTurn?(g.phase==='bidding'?'轮到你选择争分':'轮到你出牌'):`${currentPlayer?.name||'牌友'}正在思考`;
  const exitDialog=state.exitConfirm?`<div class="exit-shade"><section class="exit-dialog" role="dialog" aria-modal="true" aria-labelledby="exit-title"><span>结束本局</span><h2 id="exit-title">确定不打了吗？</h2><p>退出会按本局负场结算；好友局也会同时结束。你可以留下继续完成这一局。</p><div><button class="btn" data-action="cancel-exit">继续本局</button><button class="btn danger" data-action="confirm-exit">认输并退出</button></div></section></div>`:'';
  return `<div class="shell table"><header class="game-top"><div class="game-branding"><div class="brand compact"><div class="logo"><span></span>K</div><div>KAI PLAY<small>斗地主</small></div></div></div><div class="round-state"><span>${turnText}</span><b>基础系数 ${g.baseStake} · 当前 ${Math.max(1,2**g.bombs)}</b></div><div class="score-pill compact-score"><small>竞技分</small><strong>${money(competitiveScore(state.profile))}</strong></div></header>${result}<section class="landscape-table ${isDealing?'is-dealing':''}">${g.phase==='finished'?'':`<button class="table-exit table-exit-float" data-action="open-exit" aria-label="退出当前牌局">← 退出</button>`}<div class="table-score"><b>基础 ${g.baseStake}</b><span>系数 ${Math.max(1,2**g.bombs)}</span></div>${playerPod(rivals[0]||viewer,'opponent-left')}${playerPod(rivals[1]||viewer,'opponent-right')}${playerPod(viewer,'viewer-pod')}${g.bottomCards?.length?`<div class="bottom-reveal"><small>增补牌</small>${g.bottomCards.map(c=>poker(c,false)).join('')}</div>`:''}<div class="play-zone"><div class="play-cards">${lead}</div>${actionTrail(g)}</div><div class="center-controls" ${isDealing?'aria-hidden="true"':''}>${g.phase==='finished'?'':turnFeedback(g,viewerTurn)}<div class="game-actions">${actions}</div></div><footer class="hand-dock" ${isDealing?'aria-hidden="true"':''}><div class="hand">${g.hand.map(c=>poker(c,true)).join('')}</div><p>点击手牌选择 · 规则由服务端统一判定</p></footer>${isDealing?dealSequence():''}</section>${exitDialog}</div>`;
}

function casualHeader(title, mode, status) {
  return `<header class="casual-top"><button class="table-exit" data-action="casual-home">← 游戏大厅</button><div><span>${esc(mode)}</span><h1>${esc(title)}</h1></div><b>${esc(status)}</b></header>`;
}

function cardBack() { return '<span class="training-card-back" aria-label="未公开的牌"><i>K</i></span>'; }

function threeCardGame() {
  const round = state.casual?.round;
  if (!round) return lobby();
  const revealed = state.casual.revealed;
  const ranked = round.players.map((player, index) => ({ player, index, score: evaluateThreeCard(player.hand) }))
    .sort((a, b) => compareThreeCard(b.player.hand, a.player.hand));
  const winner = ranked[0];
  const result = revealed ? `<div class="training-result ${winner.index===0?'win':'lose'}"><span>${winner.index===0?'本轮获胜':'本轮结果'}</span><b>${esc(winner.player.name)} · ${esc(winner.score.label)}</b><small>免费训练局，不影响竞技分</small></div>` : '';
  const seats = round.players.slice(1).map((player) => `<article class="three-opponent"><div class="training-avatar">${esc(player.name.slice(0,1))}</div><b>${esc(player.name)}</b><div class="three-hand">${revealed ? player.hand.map((card) => poker(card,false)).join('') : player.hand.map(cardBack).join('')}</div>${revealed?`<span>${esc(evaluateThreeCard(player.hand).label)}</span>`:'<span>等待比牌</span>'}</article>`).join('');
  return `<div class="shell casual-shell">${casualHeader('炸金花','THREE CARD','免费训练 · 不计竞技分')}<section class="casual-stage three-stage">${result}<div class="three-how"><span>1 看自己的三张牌</span><i>→</i><span>2 点击翻开并比牌</span><i>→</i><span>3 最大牌型获胜</span></div><div class="three-opponents">${seats}</div><div class="three-center"><span>本局免费</span><b>${state.casual.thinking?'两位牌友正在思考…':revealed?'三家牌面已揭晓':'三张牌，一次定胜负'}</b><small>无筹码 · 无下注</small></div><article class="three-player"><div class="training-avatar">你</div><div><b>你的手牌</b><span>${esc(evaluateThreeCard(round.players[0].hand).label)}</span></div><div class="three-hand">${round.players[0].hand.map((card) => poker(card,false)).join('')}</div></article><div class="casual-actions"><button class="btn primary" data-action="three-reveal" ${state.casual.thinking||revealed?'disabled':''}>${state.casual.thinking?'牌友思考中…':'翻开并比牌'}</button><button class="btn" data-action="three-new">换一手牌</button></div></section><p class="casual-disclaimer">牌型顺序：豹子 ＞ 顺金 ＞ 金花 ＞ 顺子 ＞ 对子 ＞ 高牌。当前为单机训练，不使用现金、Token 或卡时。</p></div>`;
}

function mahjongTile(tile) {
  const selected = state.casual?.selectedTileId === tile.id;
  const tone = tile.suit === '万' ? 'wan' : tile.suit === '筒' ? 'tong' : tile.suit === '条' ? 'tiao' : 'honor';
  return `<button class="mahjong-tile ${tone} ${selected?'selected':''} ${state.casual?.round.drawnId===tile.id?'drawn':''}" data-mahjong-tile="${esc(tile.id)}" aria-label="${esc(tile.label)}"><b>${esc(tile.suit==='字'?tile.label:tile.rank)}</b><small>${esc(tile.suit==='字'?'':tile.suit)}</small></button>`;
}

function mahjongGame() {
  const round = state.casual?.round;
  if (!round) return lobby();
  const canDraw = round.hand.length === 13 && round.wall.length > 0;
  const canDiscard = round.hand.length === 14;
  const notice = round.won ? '<div class="training-result win"><span>牌型完成</span><b>胡牌</b><small>四组面子加一对将</small></div>' : '';
  const wall = Array.from({length:Math.min(18,Math.ceil(round.wall.length/8))},()=>'<i></i>').join('');
  const turnHint = canDraw ? '轮到你摸牌' : state.casual.selectedTileId ? '点击“打出所选”' : '请选择一张牌';
  return `<div class="shell casual-shell">${casualHeader('麻将','MAHJONG LAB',`牌墙 ${round.wall.length} 张`)}<section class="casual-stage mahjong-stage">${notice}<div class="mahjong-wall wall-top" aria-hidden="true">${wall}</div><div class="mahjong-wall wall-left" aria-hidden="true">${wall}</div><div class="mahjong-wall wall-right" aria-hidden="true">${wall}</div><div class="mahjong-wall wall-bottom" aria-hidden="true">${wall}</div><div class="mahjong-counter"><small>牌墙剩余</small><b>${round.wall.length}</b><span>${turnHint}</span></div><div class="discard-river"><span>牌河</span><div>${round.discards.slice(-24).map((tile)=>`<i class="river-tile">${esc(tile.label)}</i>`).join('')||`<small>${canDraw?'第一步：点击下方“摸一张”':'第二步：确认高亮牌，再点击“打出所选”'}</small>`}</div></div><div class="mahjong-hand">${sortMahjong(round.hand).map(mahjongTile).join('')}</div><div class="casual-actions"><button class="btn primary" data-action="mahjong-draw" ${canDraw&&!round.won?'':'disabled'}>① 摸一张</button><button class="btn" data-action="mahjong-discard" ${canDiscard&&state.casual.selectedTileId&&!round.won?'':'disabled'}>② 打出所选</button><button class="btn" data-action="mahjong-new">重新开局</button></div></section><p class="casual-disclaimer">完整 136 张基础牌墙，练习摸打与常规胡牌结构；暂不包含吃碰杠、花牌和多人计番。</p></div>`;
}

function slotsGame() {
  const casual = state.casual;
  if (!casual) return lobby();
  const result = casual.last?.result;
  const resultCopy = result?.tier==='jackpot' ? '三个图标完全相同' : result?.tier==='pair' ? '其中两个图标相同' : result ? '三个图标各不相同' : '点击按钮，等待三个转轮依次停止';
  return `<div class="shell casual-shell">${casualHeader('算力老虎机','COMPUTE REELS',`已旋转 ${casual.spins} 次`)}<section class="casual-stage slots-stage"><div class="slot-guide"><b>怎么玩？</b><span><i>1</i>点击免费旋转</span><span><i>2</i>三个转轮停止</span><span><i>3</i>查看图标组合</span></div><div class="slot-machine"><div class="slot-crown"><span>KAI PLAY</span><b>算力转轮</b><small>免费娱乐 · 零消耗</small></div><div class="slot-reels ${casual.spinning?'spinning':''}">${casual.reels.map((symbol,index)=>`<div class="slot-reel" style="--reel:${index}"><small>◆</small><span class="slot-symbol symbol-${symbol==='7'?'seven':'kai'}">${esc(symbol)}</span><small>★</small></div>`).join('')}</div><div class="slot-paytable"><span><b>三枚相同</b><small>三连共振</small></span><span><b>两枚相同</b><small>双核同频</small></span><span><b>各不相同</b><small>继续挑战</small></span></div><div class="slot-result ${result?.tier||''}"><b>${casual.spinning?'转轮依次停止中…':result?.label||'准备好了吗？'}</b><small>${resultCopy}</small></div><button class="slot-lever" data-action="slots-spin" ${casual.spinning?'disabled':''}><i></i><span>${casual.spinning?'正在旋转…':'免费旋转一次'}</span></button></div></section><p class="casual-disclaimer">纯视觉娱乐，不支付、不下注、不发放可兑换奖励，不会扣除竞技分、Token 或 KAI 卡时。</p></div>`;
}

function history() {
  const h=state.history;
  const games=h?.games?.length ? h.games.map(x=>`<div class="history-item"><div><span class="history-game">斗地主</span><b>${x.role==='landlord'?'领队':'协作位'} · ${x.winner==='landlord'?'领队胜':'协作方胜'}</b><small class="muted">${new Date(x.updatedAt).toLocaleString()} · 竞技系数 ${x.multiplier}</small></div><b class="${x.delta>=0?'positive':'negative'}">${x.delta>=0?'+':''}${x.delta}<small> 分</small></b></div>`).join('') : '<div class="empty-state">还没有完成对局，先去大厅玩一局斗地主吧。</div>';
  return `<div class="shell page-shell">${header()}<div class="section-head page-title"><div><span class="section-kicker">RECORD</span><h1>我的战绩</h1></div><div class="score-overview"><small>当前竞技分</small><strong>${money(competitiveScore(state.profile))}</strong></div></div><section class="card"><div class="history-list">${games}</div></section>${nav('history')}</div>`;
}

function rules() { return `<div class="shell page-shell">${header()}<div class="section-head page-title"><div><span class="section-kicker">FAIR PLAY</span><h1>规则与公平</h1></div><p>免费竞技，结果透明</p></div><section class="card"><div class="rules"><div class="rule"><span>01</span><div><h3>竞技分不是支付资产</h3><p class="muted">竞技分只用于斗地主段位、匹配与战绩展示，不可购买、提现、转让或兑换。</p></div></div><div class="rule"><span>02</span><div><h3>45 秒思考与自动托管</h3><p class="muted">斗地主真人回合有 45 秒思考时间；智能牌友会分别思考后行动，倒计时结束由服务端托管。</p></div></div><div class="rule"><span>03</span><div><h3>系统自动发牌</h3><p class="muted">斗地主开局向三位玩家各发 17 张并预留 3 张增补牌；炸金花每轮独立发三张；麻将使用 136 张基础牌墙。</p></div></div><div class="rule"><span>04</span><div><h3>竞技与试玩分区</h3><p class="muted">斗地主由服务端判定并记录战绩；炸金花、麻将和算力老虎机当前是免费训练场，不计竞技分。</p></div></div><div class="rule"><span>05</span><div><h3>卡时与输赢隔离</h3><p class="muted">KAI 卡时只用于明确的 AI 与云端服务，不作为牌桌筹码；试玩场也不支付、不下注、不发放可兑换奖励。</p></div></div></div></section>${nav('rules')}</div>`; }

function render() { app.innerHTML = state.view==='game'?game():state.view==='room'?room():state.view==='three'?threeCardGame():state.view==='mahjong'?mahjongGame():state.view==='slots'?slotsGame():state.view==='history'?history():state.view==='rules'?rules():lobby(); }

function openThreeCard() {
  stopGameSync();
  state.casual = { kind: 'three', round: newThreeCardRound(), revealed: false, thinking: false };
  state.view = 'three';
}
function openMahjong() {
  stopGameSync();
  state.casual = { kind: 'mahjong', round: newMahjongRound(), selectedTileId: null };
  state.view = 'mahjong';
}
function openSlots() {
  stopGameSync();
  state.casual = { kind: 'slots', reels: ['7', 'KAI', '⚡'], last: null, spins: 0, spinning: false };
  state.view = 'slots';
}

async function refreshProfile(){ state.profile=(await api('/v1/me')).profile; }
function stopGameSync() {
  state.waitController?.abort();
  state.waitController=null;
}
function finishDeal(gameId) {
  if (state.dealingGameId!==gameId) return;
  state.dealingGameId=null;
  state.dealTimer=null;
  render();
}
function enterGame(nextGame, {animateDeal=false}={}) {
  if (state.dealTimer) clearTimeout(state.dealTimer);
  state.game=nextGame;
  state.view='game';
  state.selected.clear();
  state.exitConfirm=false;
  const reducedMotion=globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  state.dealingGameId=animateDeal&&nextGame.phase==='bidding'&&!reducedMotion ? nextGame.id : null;
  state.dealTimer=state.dealingGameId ? setTimeout(()=>finishDeal(nextGame.id),DEAL_ANIMATION_MS) : null;
  startGameSync();
}
function startGameSync() {
  stopGameSync();
  if (state.view!=='game'||!state.game||state.game.phase==='finished') return;
  const gameId=state.game.id;
  const controller=new AbortController();
  state.waitController=controller;
  void (async()=>{
    while (!controller.signal.aborted&&state.view==='game'&&state.game?.id===gameId&&state.game.phase!=='finished') {
      const version=state.game.sequence;
      const timeoutMs=Math.max(1_000,Math.min(20_000,turnRemaining(state.game)*1_000+250));
      try {
        const result=await api(`/v1/games/${gameId}/wait?version=${version}&timeoutMs=${timeoutMs}`,{signal:controller.signal});
        if (controller.signal.aborted||state.game?.id!==gameId) return;
        if (result.game.sequence>=state.game.sequence) {
          if (result.game.sequence!==state.game.sequence) state.selected.clear();
          state.game=result.game;
          render();
        }
      } catch (error) {
        if (controller.signal.aborted||error.name==='AbortError') return;
        await new Promise(resolve=>setTimeout(resolve,1_500));
      }
    }
  })();
}
async function loadGame(id,{animateDeal=false}={}){ enterGame((await api(`/v1/games/${id}`)).game,{animateDeal}); render(); }
async function startQuickGame(){
  const activeGameId=state.game?.phase!=='finished' ? state.game?.id : null;
  let nextGame;
  try {
    nextGame=(await api('/v1/games/quick',{method:'POST',body:'{}'})).game;
  } catch (error) {
    if (error.code !== 'RELIEF_REQUIRED') throw error;
    const relief=await api('/v1/relief',{method:'POST',body:'{}'});
    state.profile=relief.profile;
    nextGame=(await api('/v1/games/quick',{method:'POST',body:'{}'})).game;
    toast('已领取免费竞技分补给');
  }
  enterGame(nextGame,{animateDeal:nextGame.id!==activeGameId});
}
async function act(fn){ if(state.busy)return; state.busy=true; try{await fn(); state.error='';}catch(e){toast(e.message);}finally{state.busy=false;render();} }

app.addEventListener('click', e => {
  const el=e.target.closest('button'); if(!el)return;
  if(el.dataset.card){ const id=el.dataset.card; state.selected.has(id)?state.selected.delete(id):state.selected.add(id); render(); return; }
  if(el.dataset.mahjongTile){ if(state.view==='mahjong'&&state.casual?.round.hand.length===14){state.casual.selectedTileId=el.dataset.mahjongTile;render();} return; }
  if(el.dataset.view){ state.view=el.dataset.view; if(state.view!=='game') stopGameSync(); if(state.view==='history') act(async()=>{state.history=await api('/v1/history');}); else render(); return; }
  if(el.dataset.bid!==undefined) act(async()=>{const body={score:Number(el.dataset.bid),expectedSequence:state.game.sequence};const r=await api(`/v1/games/${state.game.id}/bid`,{method:'POST',body:JSON.stringify(body),headers:{'x-request-id':requestId()}});state.game=r.game;state.profile=r.profile;});
  const a=el.dataset.action;
  if(a==='quick') act(startQuickGame);
  if(a==='scroll-games') document.querySelector('#game-selection')?.scrollIntoView({behavior:'smooth',block:'start'});
  if(a==='open-three'){openThreeCard();render();}
  if(a==='open-mahjong'){openMahjong();render();}
  if(a==='open-slots'){openSlots();render();}
  if(a==='casual-home'){state.casual=null;state.view='lobby';render();}
  if(a==='three-new'){state.casual={kind:'three',round:newThreeCardRound(),revealed:false,thinking:false};render();}
  if(a==='three-reveal'&&state.view==='three'&&!state.casual?.thinking&&!state.casual?.revealed){
    state.casual.thinking=true;render();setTimeout(()=>{if(state.view!=='three'||!state.casual)return;state.casual.thinking=false;state.casual.revealed=true;render();},1_400);
  }
  if(a==='mahjong-new'){state.casual={kind:'mahjong',round:newMahjongRound(),selectedTileId:null};render();}
  if(a==='mahjong-draw'&&state.view==='mahjong'){
    const round=state.casual.round;
    if(round.hand.length!==13||!round.wall.length)return;
    const drawn=round.wall.shift();round.hand=sortMahjong([...round.hand,drawn]);round.drawnId=drawn.id;round.won=isWinningMahjong(round.hand);state.casual.selectedTileId=drawn.id;render();
  }
  if(a==='mahjong-discard'&&state.view==='mahjong'){
    const round=state.casual.round;const tile=round.hand.find(candidate=>candidate.id===state.casual.selectedTileId);
    if(!tile||round.hand.length!==14)return;
    round.hand=round.hand.filter(candidate=>candidate.id!==tile.id);round.discards.push(tile);round.drawnId=null;state.casual.selectedTileId=null;render();
  }
  if(a==='slots-spin'&&state.view==='slots'&&!state.casual?.spinning){
    state.casual.spinning=true;state.casual.last=null;render();
    setTimeout(()=>{if(state.view!=='slots'||!state.casual)return;const next=spinSlots();state.casual.reels=next.reels;state.casual.last=next;state.casual.spins+=1;state.casual.spinning=false;render();},850);
  }
  if(a==='resume') act(async()=>{const r=await api('/v1/resume');if(r.game){enterGame(r.game);}else if(r.room){state.room=r.room;state.view='room';}else toast('没有待恢复的牌局');});
  if(a==='create-room') act(async()=>{state.room=(await api('/v1/rooms',{method:'POST',body:'{}'})).room;state.view='room';});
  if(a==='join-room') act(async()=>{const code=document.querySelector('#room-code')?.value.trim();if(!/^\d{6}$/.test(code))throw new Error('请输入 6 位房号');state.room=(await api('/v1/rooms/join',{method:'POST',body:JSON.stringify({code})})).room;state.view='room';});
  if(a==='copy-room') {
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(state.room.code).then(()=>toast('房号已复制')).catch(()=>toast(`房号：${state.room.code}`));
    else toast(`房号：${state.room.code}`);
  }
  if(a==='refresh-room') act(async()=>{state.room=(await api(`/v1/rooms/${state.room.id}`)).room;if(state.room.gameId)await loadGame(state.room.gameId,{animateDeal:true});});
  if(a==='start-room') act(async()=>{const r=await api(`/v1/rooms/${state.room.id}/start`,{method:'POST',body:'{}'});state.room=r.room;enterGame(r.game,{animateDeal:true});});
  if(a==='leave-room') act(async()=>{await api(`/v1/rooms/${state.room.id}/leave`,{method:'POST',body:'{}'});state.room=null;state.view='lobby';});
  if(a==='pass') act(async()=>{const r=await api(`/v1/games/${state.game.id}/pass`,{method:'POST',body:JSON.stringify({expectedSequence:state.game.sequence}),headers:{'x-request-id':requestId()}});state.game=r.game;state.profile=r.profile;});
  if(a==='play') act(async()=>{if(!state.selected.size)throw new Error('请先选择要出的牌');const r=await api(`/v1/games/${state.game.id}/play`,{method:'POST',body:JSON.stringify({cardIds:[...state.selected],expectedSequence:state.game.sequence}),headers:{'x-request-id':requestId()}});state.game=r.game;state.profile=r.profile;state.selected.clear();});
  if(a==='finish') act(async()=>{stopGameSync();await refreshProfile();state.game=null;state.view='lobby';});
  if(a==='open-exit'){state.exitConfirm=true;render();}
  if(a==='cancel-exit'){state.exitConfirm=false;render();}
  if(a==='confirm-exit') act(async()=>{const r=await api(`/v1/games/${state.game.id}/abandon`,{method:'POST',body:'{}'});stopGameSync();state.profile=r.profile;state.game=null;state.exitConfirm=false;state.view='lobby';toast('已退出本局');});
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
