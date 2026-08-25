import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator, Pressable, ScrollView, Share, StyleSheet, Text, View,
  TextInput,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import { Ionicons } from '@expo/vector-icons';
import { ApiError, bootstrap, claimRelief, createRoom, gameAction, getGame, getRoom, history, joinRoom, leaveRoom, me, quickGame, reportGame, resumeSession, startRoom } from './src/api';
import type { Card, ComboType, GameView, History, PlayerView, Profile, RoomView } from './src/types';
import { useRoomSync } from './src/use-room-sync';
import { useGameSync } from './src/use-game-sync';

const C = {
  ink: '#F6F1E7', muted: '#AAB8AF', green: '#0B332A', deep: '#041713',
  panel: '#102E27', line: 'rgba(255,255,255,0.10)', lime: '#B7F35D',
  gold: '#F4C968', red: '#E6635A', white: '#FFFDF7', black: '#17211E',
};

const TURN_TIMEOUT_SECONDS = 45;
type ConnectionStatus = 'connecting' | 'online' | 'offline';

const comboNames: Record<ComboType, string> = {
  single: '单张', pair: '对子', triple: '三张', triple_single: '三带一', triple_pair: '三带二',
  straight: '顺子', pair_straight: '连对', airplane: '飞机', airplane_single: '飞机带单',
  airplane_pair: '飞机带对', four_two_single: '四带二', four_two_pair: '四带两对', bomb: '炸弹', rocket: '王炸',
};

function number(value: number) { return new Intl.NumberFormat('zh-CN').format(value); }

function productCopy(value: string) {
  return value
    .replace(/新玩家欢迎赠豆/g, '新玩家初始竞技分')
    .replace(/每日补助/g, '每日竞技分补给')
    .replace(/欢乐豆/g, '竞技分')
    .replace(/补助/g, '补给')
    .replace(/扣豆/g, '扣分')
    .replace(/派奖/g, '结算');
}

function cardText(card: Card) {
  if (card.rank === 16) return { rank: '小王', suit: '♛', red: false };
  if (card.rank === 17) return { rank: '大王', suit: '♛', red: true };
  const rank = card.rank <= 10 ? String(card.rank) : ({ 11: 'J', 12: 'Q', 13: 'K', 14: 'A', 15: '2' } as Record<number, string>)[card.rank]!;
  const suit = { spade: '♠', heart: '♥', club: '♣', diamond: '♦', joker: '' }[card.suit];
  return { rank, suit, red: card.suit === 'heart' || card.suit === 'diamond' };
}

function cardAccessibilityLabel(card: Card) {
  if (card.rank === 16) return '小王';
  if (card.rank === 17) return '大王';
  const { rank } = cardText(card);
  const suit = { spade: '黑桃', heart: '红桃', club: '梅花', diamond: '方块', joker: '' }[card.suit];
  return `${suit}${rank}`;
}

function isConnectionIssue(value: unknown) {
  return !(value instanceof ApiError) || value.status >= 500 || value.code === 'NETWORK_ERROR';
}

function PlayingCard({ card, selected = false, small = false, onPress }: {
  card: Card; selected?: boolean; small?: boolean; onPress?: () => void;
}) {
  const label = cardText(card);
  return (
    <Pressable
      accessible
      accessibilityRole={onPress ? 'button' : 'text'}
      accessibilityLabel={`${cardAccessibilityLabel(card)}${selected ? '，已选择' : ''}`}
      accessibilityHint={onPress ? '双击切换选择状态' : undefined}
      accessibilityState={onPress ? { selected } : undefined}
      disabled={!onPress}
      onPress={onPress}
      style={({ pressed }) => [
      styles.card, small && styles.cardSmall, selected && styles.cardSelected, pressed && { opacity: 0.86 },
    ]}>
      <Text maxFontSizeMultiplier={1.2} style={[styles.cardRank, small && styles.cardRankSmall, label.red && styles.cardRed]}>{label.rank}</Text>
      <Text maxFontSizeMultiplier={1.2} style={[styles.cardSuit, small && styles.cardSuitSmall, label.red && styles.cardRed]}>{label.suit}</Text>
    </Pressable>
  );
}

function Pill({ icon, children, tone = 'default' }: { icon?: keyof typeof Ionicons.glyphMap; children: React.ReactNode; tone?: 'default' | 'lime' }) {
  return <View style={[styles.pill, tone === 'lime' && styles.pillLime]}>
    {icon ? <Ionicons name={icon} size={14} color={tone === 'lime' ? C.deep : C.gold} /> : null}
    <Text style={[styles.pillText, tone === 'lime' && { color: C.deep }]}>{children}</Text>
  </View>;
}

function AppHeader({ profile, onHome }: { profile: Profile; onHome: () => void }) {
  return <View style={styles.header}>
    <Pressable accessibilityRole="button" accessibilityLabel="KAI Play，返回游戏大厅" onPress={onHome} style={styles.brandRow}>
      <View style={styles.brandMark}><Text style={styles.brandMarkText}>K</Text></View>
      <View><Text style={styles.brand}>KAI PLAY</Text><Text style={styles.brandSub}>算力局</Text></View>
    </Pressable>
    <View accessible accessibilityLabel={`竞技分 ${number(profile.balance)}，不可购买、转让或提现`} style={styles.balance}><View style={styles.scoreDot} /><Text style={styles.balanceText}>{number(profile.balance)}</Text><Text style={styles.balanceUnit}>竞技分</Text></View>
  </View>;
}

function ConnectionBanner({ status, retrying, onRetry }: {
  status: ConnectionStatus; retrying: boolean; onRetry: () => void;
}) {
  if (status === 'online') return null;
  const offline = status === 'offline';
  return <View
    accessibilityRole="alert"
    accessibilityLiveRegion="assertive"
    style={[styles.connectionBanner, offline && styles.connectionBannerOffline]}
  >
    {retrying || !offline
      ? <ActivityIndicator size="small" color={offline ? C.deep : C.gold} />
      : <Ionicons name="cloud-offline-outline" size={18} color={C.deep} />}
    <View style={styles.connectionCopy}>
      <Text style={[styles.connectionTitle, offline && styles.connectionTextOffline]}>{offline ? '网络连接中断' : '正在连接牌局服务'}</Text>
      <Text style={[styles.connectionHint, offline && styles.connectionHintOffline]}>{offline ? '当前牌桌已保留，可手动重试' : '正在恢复你的最新状态'}</Text>
    </View>
    {offline ? <Pressable
      accessibilityRole="button"
      accessibilityLabel="重新连接牌局服务"
      accessibilityState={{ busy: retrying, disabled: retrying }}
      disabled={retrying}
      onPress={onRetry}
      style={styles.connectionRetry}
    >
      <Text style={styles.connectionRetryText}>{retrying ? '重连中' : '重试'}</Text>
    </Pressable> : null}
  </View>;
}

function Lobby({ profile, busy, onQuick, onRelief, onCreateRoom, onJoinRoom }: {
  profile: Profile; busy: boolean; onQuick: () => void; onRelief: () => void;
  onCreateRoom: () => void; onJoinRoom: (code: string) => void;
}) {
  const [roomCode, setRoomCode] = useState('');
  const games: ReadonlyArray<{ name: string; copy: string; icon: keyof typeof Ionicons.glyphMap; available: boolean }> = [
    { name: '三人争先', copy: '原创三人牌局', icon: 'layers-outline', available: true },
    { name: 'KAI 象棋', copy: '棋局与 AI 复盘', icon: 'grid-outline', available: false },
    { name: '三张竞技', copy: '积分回合竞技', icon: 'copy-outline', available: false },
    { name: 'AI 挑战场', copy: '残局与棋力闯关', icon: 'sparkles-outline', available: false },
  ];
  return <ScrollView contentContainerStyle={styles.lobby} showsVerticalScrollIndicator={false}>
    <View style={styles.greeting}><Text style={styles.eyebrow}>KAI PLAY · 晚上好，{profile.name}</Text><Text style={styles.heroTitle}>算力驱动，随时开局。</Text><Text style={styles.heroCopy}>游戏免费，胜负只影响不可交易的竞技分。</Text></View>
    <LinearGradient colors={['#174F40', '#092A23']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.heroCard}>
      <View style={styles.heroGlow} />
      <View style={styles.tableStamp}><Text style={styles.tableStampTop}>原 创</Text><Text style={styles.tableStampMain}>争</Text><Text style={styles.tableStampBottom}>三人场</Text></View>
      <View style={styles.heroBody}>
        <Pill icon="shield-checkmark" tone="lime">公平洗牌 · 服务端判定</Pill>
        <Text style={styles.modeTitle}>三人争先</Text>
        <Text style={styles.modeMeta}>竞技分保护性底分 · 最高 64 倍 · 不涉及现实资产</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="快速开始三人争先" accessibilityHint="立即匹配一局三人牌局" accessibilityState={{ disabled: busy, busy }} disabled={busy} onPress={onQuick} style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed, busy && { opacity: 0.7 }]}>
          {busy ? <ActivityIndicator color={C.deep} /> : <><Text style={styles.primaryText}>快速开始</Text><Ionicons name="arrow-forward" size={20} color={C.deep} /></>}
        </Pressable>
      </View>
    </LinearGradient>

    <View style={styles.gameSection}>
      <View style={styles.sectionHeadingRow}><Text style={styles.sectionHeading}>游戏大厅</Text><Text style={styles.sectionHint}>更多玩法持续加入</Text></View>
      <View style={styles.gameGrid}>{games.map((item) => <Pressable
        key={item.name}
        accessibilityRole="button"
        accessibilityLabel={`${item.name}，${item.available ? '当前可玩' : '即将开放'}`}
        accessibilityHint={item.available ? '快速开始游戏' : '该游戏仍在开发中'}
        accessibilityState={{ disabled: !item.available || busy, busy: item.available && busy }}
        disabled={!item.available || busy}
        onPress={item.available ? onQuick : undefined}
        style={({ pressed }) => [styles.gameCard, item.available && styles.gameCardAvailable, pressed && styles.pressed]}
      >
        <View style={[styles.gameIcon, item.available && styles.gameIconAvailable]}><Ionicons name={item.icon} size={21} color={item.available ? C.deep : C.muted} /></View>
        <Text style={styles.gameName}>{item.name}</Text>
        <Text style={styles.gameCopy}>{item.copy}</Text>
        <Text style={[styles.gameStatus, item.available && styles.gameStatusAvailable]}>{item.available ? '当前可玩' : '即将开放'}</Text>
      </Pressable>)}</View>
    </View>

    <View style={styles.statRow}>
      <View style={styles.stat}><Text style={styles.statValue}>{profile.games}</Text><Text style={styles.statLabel}>已玩牌局</Text></View>
      <View style={styles.statDivider} />
      <View style={styles.stat}><Text style={styles.statValue}>{profile.winRate}%</Text><Text style={styles.statLabel}>胜率</Text></View>
      <View style={styles.statDivider} />
      <View style={styles.stat}><Text style={styles.statValue}>{profile.wins}</Text><Text style={styles.statLabel}>获胜</Text></View>
    </View>

    <View style={styles.friendCard}>
      <View style={styles.friendHeading}><View style={{ flex: 1, paddingRight: 8 }}><Text style={styles.friendTitle}>好友房</Text><Text style={styles.friendCopy}>三人真人对局，不足三人可由机器人补位</Text></View><Ionicons name="people-outline" size={23} color={C.gold} /></View>
      <View style={styles.friendActions}>
        <Pressable accessibilityRole="button" accessibilityLabel="创建好友房" accessibilityState={{ disabled: busy, busy }} disabled={busy} onPress={onCreateRoom} style={styles.createRoomButton}><Ionicons name="add" size={18} color={C.ink} /><Text style={styles.createRoomText}>创建房间</Text></Pressable>
        <View style={styles.joinBox}><TextInput accessibilityLabel="六位好友房房间号" accessibilityHint="输入朋友分享的六位数字" value={roomCode} onChangeText={(value) => setRoomCode(value.replace(/\D/g, '').slice(0, 6))} placeholder="6 位房间号" placeholderTextColor="#718078" keyboardType="number-pad" maxLength={6} maxFontSizeMultiplier={1.5} style={styles.roomInput} /><Pressable accessibilityRole="button" accessibilityLabel="加入好友房" accessibilityState={{ disabled: busy || roomCode.length !== 6, busy }} disabled={busy || roomCode.length !== 6} onPress={() => onJoinRoom(roomCode)} style={[styles.joinButton, roomCode.length !== 6 && styles.disabled]}><Text style={styles.joinText}>加入</Text></Pressable></View>
      </View>
    </View>

    {profile.balance < 2_000 ? <Pressable accessibilityRole="button" accessibilityLabel="领取今日竞技分补给" accessibilityHint="将低竞技分免费补足至两千分" onPress={onRelief} style={styles.reliefCard}>
      <View style={styles.reliefIcon}><Ionicons name="gift-outline" size={22} color={C.gold} /></View>
      <View style={{ flex: 1 }}><Text style={styles.reliefTitle}>今日竞技分补给</Text><Text style={styles.reliefCopy}>低于门槛时可免费补足至 2,000 分</Text></View>
      <Ionicons name="chevron-forward" size={20} color={C.muted} />
    </Pressable> : null}

    <View style={styles.policyCard}>
      <Ionicons name="leaf-outline" size={22} color={C.lime} />
      <View style={{ flex: 1 }}><Text style={styles.policyTitle}>竞技分只记录游戏表现</Text><Text style={styles.policyCopy}>不可购买 · 不可提现 · 不可转让 · 不可兑换</Text></View>
    </View>

    <View accessible accessibilityLabel="卡时服务规划中，包括 AI 复盘、高级 AI 对手和云端托管；暂未接入，当前不会扣除卡时" style={styles.computeCard}>
      <View style={styles.computeTop}><View style={styles.computeIcon}><Ionicons name="flash-outline" size={22} color={C.gold} /></View><View style={{ flex: 1 }}><Text style={styles.computeTitle}>卡时服务</Text><Text style={styles.computeBadge}>规划中 · 尚未接入</Text></View></View>
      <Text style={styles.computeCopy}>未来可使用 KAI 卡时购买真实算力服务，不参与牌局输赢。</Text>
      <View style={styles.computeTags}>{['AI 复盘', '高级 AI', '云端托管'].map((label) => <View key={label} style={styles.computeTag}><Text style={styles.computeTagText}>{label}</Text></View>)}</View>
      <Text style={styles.computeNotice}>当前不会产生任何卡时消耗</Text>
    </View>
  </ScrollView>;
}

function RoomScreen({ room, busy, onStart, onLeave, onShare }: {
  room: RoomView; busy: boolean; onStart: () => void; onLeave: () => void; onShare: () => void;
}) {
  const slots = [...room.members, ...Array.from({ length: 3 - room.members.length }, (_, index) => ({ id: `empty-${index}`, name: '等待加入', isYou: false }))];
  return <ScrollView contentContainerStyle={styles.roomPage} showsVerticalScrollIndicator={false}>
    <View style={styles.roomTop}><Pressable accessibilityRole="button" accessibilityLabel="离开好友房" hitSlop={8} onPress={onLeave} style={styles.circleButton}><Ionicons name="close" size={22} color={C.ink} /></Pressable><Text style={styles.roomTopTitle}>好友房</Text><View style={{ width: 38 }} /></View>
    <View style={styles.roomCodeCard}>
      <Text style={styles.roomCodeLabel}>房间号</Text>
      <Text accessibilityLabel={`好友房房间号 ${room.code.split('').join(' ')}`} selectable adjustsFontSizeToFit minimumFontScale={0.72} numberOfLines={1} style={styles.roomCode}>{room.code}</Text>
      <Text style={styles.roomCodeHint}>长按号码可选择复制，也可直接分享给朋友</Text>
      <Pressable accessibilityRole="button" accessibilityLabel={`分享房间号 ${room.code}`} onPress={onShare} style={styles.shareRoomButton}>
        <Ionicons name="share-social-outline" size={18} color={C.deep} />
        <Text style={styles.shareRoomText}>分享房间号</Text>
      </Pressable>
    </View>
    <View style={styles.roomPlayers}>{slots.map((member, index) => <View key={member.id} style={[styles.roomPlayer, member.id.startsWith('empty-') && styles.roomPlayerEmpty]}>
      <View style={[styles.roomAvatar, member.id.startsWith('empty-') && { backgroundColor: 'rgba(255,255,255,0.06)' }]}><Ionicons name={member.id.startsWith('empty-') ? 'person-add-outline' : 'person'} size={25} color={member.id.startsWith('empty-') ? C.muted : C.deep} /></View>
      <Text style={styles.roomPlayerName}>{member.name}{member.isYou ? '（你）' : ''}</Text>
      <Text style={styles.roomPlayerMeta}>{member.id === room.hostId ? '房主' : member.id.startsWith('empty-') ? `座位 ${index + 1}` : '已准备'}</Text>
    </View>)}</View>
    <View style={styles.roomNotice}><Ionicons name="sync-outline" size={17} color={C.lime} /><Text style={styles.roomNoticeText}>房间状态自动同步，无需手动刷新</Text></View>
    <View style={{ flex: 1 }} />
    {room.isHost ? <Pressable accessibilityRole="button" accessibilityLabel={room.members.length === 3 ? '开始真人对局' : `开始对局并补入 ${3 - room.members.length} 个机器人`} accessibilityState={{ disabled: busy, busy }} disabled={busy} onPress={onStart} style={styles.primaryButton}>{busy ? <ActivityIndicator color={C.deep} /> : <><Text style={styles.primaryText}>{room.members.length === 3 ? '开始真人对局' : `开始并补入 ${3 - room.members.length} 个机器人`}</Text><Ionicons name="play" size={19} color={C.deep} /></>}</Pressable> : <View accessible accessibilityLabel="等待房主开始对局" style={styles.waitHost}><ActivityIndicator color={C.lime} size="small" /><Text style={styles.waitHostText}>等待房主开始…</Text></View>}
    <Text style={styles.roomPolicy}>本房间只结算不可购买、转让或提现的竞技分</Text>
  </ScrollView>;
}

function Opponent({ player, active, turnRemaining }: { player: PlayerView; active: boolean; turnRemaining: number }) {
  const status = active ? (turnRemaining > 0 ? `剩 ${turnRemaining} 秒` : '托管判定中…') : `${player.cardCount} 张牌`;
  return <View accessible accessibilityLabel={`${player.name}，${player.role === 'landlord' ? '领队' : player.role === 'farmer' ? '协作位' : '身份未定'}，${status}`} style={[styles.opponent, active && styles.opponentActive]}>
    <View style={styles.avatar}><Ionicons name="person" size={22} color={C.deep} /></View>
    <View style={{ flex: 1 }}>
      <View style={styles.opponentNameRow}><Text style={styles.opponentName}>{player.name}</Text>{player.role ? <Text style={[styles.role, player.role === 'landlord' && styles.roleLandlord]}>{player.role === 'landlord' ? '领队' : '协作位'}</Text> : null}</View>
      <Text style={[styles.opponentMeta, active && turnRemaining <= 10 && styles.turnUrgentText]}>{status}</Text>
    </View>
    <View style={styles.backCards}><View style={styles.cardBack} /><View style={[styles.cardBack, { marginLeft: -14 }]} /><Text style={styles.cardCount}>{player.cardCount}</Text></View>
  </View>;
}

function Table({ game, profile, busy, onAction, onExit, onReport }: {
  game: GameView; profile: Profile; busy: boolean;
  onAction: (kind: 'bid' | 'play' | 'pass', input?: object) => void; onExit: () => void;
  onReport: (reason: 'collusion' | 'cheating' | 'harassment' | 'other') => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [reportOpen, setReportOpen] = useState(false);
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => setSelected([]), [game.updatedAt]);
  useEffect(() => {
    setClock(Date.now());
    if (game.phase === 'finished') return;
    const timer = setInterval(() => setClock(Date.now()), 500);
    return () => clearInterval(timer);
  }, [game.updatedAt, game.phase]);
  const opponents = game.players.filter((player) => player.id !== profile.id);
  const me = game.players.find((player) => player.id === profile.id)!;
  const myTurn = game.currentSeat === game.viewerSeat && game.phase !== 'finished';
  const current = game.players[game.currentSeat];
  const delta = game.settlement?.deltas[profile.id] ?? 0;
  const turnDeadline = Date.parse(game.updatedAt) + TURN_TIMEOUT_SECONDS * 1_000;
  const turnRemaining = game.phase === 'finished' ? 0 : Math.max(0, Math.ceil((turnDeadline - clock) / 1_000));
  const timerUrgent = turnRemaining <= 10;

  function toggle(id: string) {
    Haptics.selectionAsync().catch(() => undefined);
    setSelected((currentSelection) => currentSelection.includes(id) ? currentSelection.filter((value) => value !== id) : [...currentSelection, id]);
  }

  return <View style={styles.tablePage}>
    <View style={styles.tableTopbar}>
      <Pressable accessibilityRole="button" accessibilityLabel="离开当前牌桌" hitSlop={8} onPress={onExit} style={styles.circleButton}><Ionicons name="chevron-back" size={22} color={C.ink} /></Pressable>
      <View accessible accessibilityLabel={`三人争先，底分 ${game.baseStake}，当前 ${Math.max(1, game.highestBid) * (2 ** game.bombs)} 倍，四十五秒自动托管`} style={styles.tableMeta}><Text style={styles.tableMetaTop}>三人争先</Text><Text numberOfLines={2} style={styles.tableMetaBottom}>底分 {game.baseStake} · {Math.max(1, game.highestBid) * (2 ** game.bombs)} 倍 · 45 秒自动托管</Text></View>
      <Pressable accessibilityRole="button" accessibilityLabel="打开牌桌菜单" accessibilityState={{ expanded: reportOpen }} hitSlop={8} onPress={() => setReportOpen((value) => !value)} style={styles.circleButton}><Ionicons name="ellipsis-horizontal" size={21} color={C.ink} /></Pressable>
    </View>
    {reportOpen ? <View style={styles.reportMenu}>
      <Text style={styles.reportMenuTitle}>举报本局</Text>
      {([['cheating', '疑似作弊'], ['collusion', '疑似串通'], ['harassment', '不当行为'], ['other', '其他问题']] as const).map(([reason, label]) => <Pressable accessibilityRole="button" accessibilityLabel={`举报：${label}`} key={reason} onPress={() => { setReportOpen(false); onReport(reason); }} style={styles.reportOption}><Text style={styles.reportOptionText}>{label}</Text><Ionicons name="chevron-forward" size={16} color={C.muted} /></Pressable>)}
    </View> : null}

    <View style={styles.opponentsRow}>{opponents.map((player) => <Opponent key={player.id} player={player} active={game.currentSeat === player.seat && game.phase !== 'finished'} turnRemaining={turnRemaining} />)}</View>

    <View style={styles.felt}>
      <View style={styles.bottomCards}>
        <Text style={styles.bottomLabel}>底牌</Text>
        {game.bottomCards.length ? game.bottomCards.map((card) => <PlayingCard key={card.id} card={card} small />) : <><View style={styles.mysteryCard} /><View style={styles.mysteryCard} /><View style={styles.mysteryCard} /></>}
      </View>
      <View style={styles.playZone}>
        {game.phase !== 'finished' ? <View
          accessible
          accessibilityLabel={`${myTurn ? '你的回合' : `${current?.name ?? '当前玩家'}的回合`}，${turnRemaining > 0 ? `剩余 ${turnRemaining} 秒` : '已到托管时间，等待服务端判定'}`}
          accessibilityLiveRegion={timerUrgent ? 'polite' : 'none'}
          style={[styles.turnTimer, timerUrgent && styles.turnTimerUrgent]}
        >
          <Ionicons name={turnRemaining > 0 ? 'timer-outline' : 'hourglass-outline'} size={17} color={timerUrgent ? C.deep : C.gold} />
          <Text style={[styles.turnTimerValue, timerUrgent && styles.turnTimerValueUrgent]}>{turnRemaining > 0 ? turnRemaining : '托管'}</Text>
          <Text style={[styles.turnTimerUnit, timerUrgent && styles.turnTimerValueUrgent]}>{turnRemaining > 0 ? '秒' : '判定中'}</Text>
        </View> : null}
        {game.leadCards.length ? <>
          <Text style={styles.leadBy}>{game.leadCombination ? comboNames[game.leadCombination.type] : '出牌'}</Text>
          <View style={styles.leadCards}>{game.leadCards.map((card, index) => <View key={card.id} style={{ marginLeft: index ? -8 : 0 }}><PlayingCard card={card} small /></View>)}</View>
        </> : <View style={styles.turnPrompt}><View style={styles.turnPulse} /><Text style={styles.turnText}>{myTurn ? '轮到你了' : `${current?.name ?? ''} 正在出牌`}</Text></View>}
      </View>
      {game.phase === 'bidding' ? <View style={styles.bidPanel}>
        <Text accessibilityLiveRegion="polite" style={[styles.actionHint, myTurn && timerUrgent && styles.turnUrgentText]}>{myTurn ? (turnRemaining > 0 ? (timerUrgent ? `请争分，${turnRemaining} 秒后自动托管` : '选择争分') : '正在等待服务端托管争分') : `${current?.name} 正在争分`}</Text>
        <View style={styles.actionRow}>
          <Pressable accessibilityRole="button" accessibilityLabel="不争" accessibilityState={{ disabled: !myTurn || busy }} disabled={!myTurn || busy} onPress={() => onAction('bid', { score: 0 })} style={styles.secondaryButton}><Text style={styles.secondaryText}>不争</Text></Pressable>
          {([1, 2, 3] as const).filter((score) => score > game.highestBid).map((score) => <Pressable accessibilityRole="button" accessibilityLabel={`争 ${score} 分`} accessibilityState={{ disabled: !myTurn || busy }} key={score} disabled={!myTurn || busy} onPress={() => onAction('bid', { score })} style={styles.bidButton}><Text style={styles.bidText}>{score} 分</Text></Pressable>)}
        </View>
      </View> : game.phase === 'playing' ? <View style={styles.actionPanel}>
        <Text accessibilityLiveRegion="polite" style={[styles.actionHint, myTurn && timerUrgent && styles.turnUrgentText]}>{myTurn ? (turnRemaining === 0 ? '正在等待服务端托管出牌' : timerUrgent ? `还剩 ${turnRemaining} 秒，请尽快出牌` : selected.length ? `已选 ${selected.length} 张` : '请选择要出的牌') : '等待其他玩家'}</Text>
        <View style={styles.actionRow}>
          <Pressable accessibilityRole="button" accessibilityLabel="不出" accessibilityState={{ disabled: !myTurn || busy || !game.leadCombination }} disabled={!myTurn || busy || !game.leadCombination} onPress={() => onAction('pass')} style={[styles.secondaryButton, (!myTurn || !game.leadCombination) && styles.disabled]}><Text style={styles.secondaryText}>不出</Text></Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel={selected.length ? `打出已选的 ${selected.length} 张牌` : '出牌'} accessibilityState={{ disabled: !myTurn || busy || !selected.length, busy }} disabled={!myTurn || busy || !selected.length} onPress={() => onAction('play', { cardIds: selected })} style={[styles.playButton, (!myTurn || !selected.length) && styles.disabled]}>
            {busy ? <ActivityIndicator color={C.deep} /> : <Text style={styles.playText}>出牌</Text>}
          </Pressable>
        </View>
      </View> : null}
    </View>

    <View style={styles.myInfo}><View><Text style={styles.myName}>{me.name} <Text style={[styles.role, me.role === 'landlord' && styles.roleLandlord]}>{me.role === 'landlord' ? '领队' : me.role === 'farmer' ? '协作位' : ''}</Text></Text><Text style={styles.myBalance}>● {number(profile.balance)} 竞技分</Text></View><Text style={styles.handCount}>{game.hand.length} 张</Text></View>
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.hand}>
      {game.hand.map((card, index) => <View key={card.id} style={{ marginLeft: index ? -20 : 0 }}><PlayingCard card={card} selected={selected.includes(card.id)} onPress={game.phase === 'playing' && myTurn ? () => toggle(card.id) : undefined} /></View>)}
    </ScrollView>

    {game.phase === 'finished' ? <View style={styles.resultShade}>
      <View style={styles.resultCard}>
        <Text style={styles.resultEyebrow}>{game.settlement?.winner === 'landlord' ? '领队胜利' : '协作位胜利'}</Text>
        <Text style={styles.resultTitle}>{delta >= 0 ? '漂亮！' : '再来一局'}</Text>
        <Text style={[styles.resultDelta, delta < 0 && { color: C.red }]}>{delta >= 0 ? '+' : ''}{number(delta)} <Text style={styles.resultUnit}>竞技分</Text></Text>
        <Text style={styles.resultMeta}>{game.settlement?.multiplier} 倍结算 · 竞技记录已保存</Text>
        <Text style={styles.fairnessCode}>公平校验 {game.fairness.commitment.slice(0, 12)}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="回到大厅" onPress={onExit} style={styles.primaryButton}><Text style={styles.primaryText}>回到大厅</Text><Ionicons name="home-outline" size={20} color={C.deep} /></Pressable>
      </View>
    </View> : null}
  </View>;
}

function HistoryScreen({ data, loading }: { data: History | null; loading: boolean }) {
  if (loading) return <View style={styles.center}><ActivityIndicator color={C.lime} /></View>;
  return <ScrollView contentContainerStyle={styles.contentPage}>
    <Text style={styles.pageEyebrow}>MY RECORDS</Text><Text style={styles.pageTitle}>战绩与账本</Text>
    <Text style={styles.sectionTitle}>最近牌局</Text>
    {!data?.games.length ? <View style={styles.empty}><Ionicons name="albums-outline" size={28} color={C.muted} /><Text style={styles.emptyText}>还没有完成的牌局</Text></View> : data.games.map((game) => <View key={game.id} style={styles.historyRow}>
      <View style={[styles.historyIcon, game.delta >= 0 ? styles.historyWin : styles.historyLose]}><Ionicons name={game.delta >= 0 ? 'trophy' : 'flag'} size={18} color={game.delta >= 0 ? C.lime : C.red} /></View>
      <View style={{ flex: 1 }}><Text style={styles.historyTitle}>{game.role === 'landlord' ? '领队' : '协作位'} · {game.multiplier} 倍</Text><Text style={styles.historyDate}>{new Date(game.updatedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</Text></View>
      <Text style={[styles.historyDelta, game.delta < 0 && { color: C.red }]}>{game.delta >= 0 ? '+' : ''}{number(game.delta)}</Text>
    </View>)}
    <Text style={[styles.sectionTitle, { marginTop: 24 }]}>竞技分记录</Text>
    {data?.ledger.map((entry) => <View key={entry.id} style={styles.ledgerRow}><View><Text style={styles.ledgerMemo}>{productCopy(entry.memo)}</Text><Text style={styles.historyDate}>{new Date(entry.createdAt).toLocaleString('zh-CN')}</Text></View><Text style={[styles.ledgerAmount, entry.amount < 0 && { color: C.red }]}>{entry.amount >= 0 ? '+' : ''}{number(entry.amount)}</Text></View>)}
  </ScrollView>;
}

function RulesScreen() {
  const rules = [
    ['01', '竞技分边界', '竞技分只记录游戏表现，不支持购买、提现、转让或兑换。'],
    ['02', '服务端权威', '洗牌、争分、出牌合法性与最终结算全部由服务端完成。'],
    ['03', '争分与身份', '三人依次选择不争或争 1–3 分，最高分玩家成为领队并获得三张底牌，其余两位成为协作位。'],
    ['04', '倍数保护', '炸弹、王炸和春天会翻倍，单局最高 64 倍，并按竞技分设置保护底分。'],
  ];
  return <ScrollView contentContainerStyle={styles.contentPage}><Text style={styles.pageEyebrow}>FAIR PLAY</Text><Text style={styles.pageTitle}>规则与公平</Text><Text style={styles.pageIntro}>我们希望每一局都简单、透明、没有现实金钱压力。</Text>
    {rules.map(([index, title, copy]) => <View key={index} style={styles.ruleRow}><Text style={styles.ruleIndex}>{index}</Text><View style={{ flex: 1 }}><Text style={styles.ruleTitle}>{title}</Text><Text style={styles.ruleCopy}>{copy}</Text></View></View>)}
    <View style={styles.fairCard}><Ionicons name="shield-checkmark-outline" size={28} color={C.lime} /><Text style={styles.fairTitle}>公平性承诺</Text><Text style={styles.fairCopy}>每局使用操作系统安全随机源洗牌；所有动作都有顺序编号，重复请求不会造成重复扣分或结算。</Text></View>
  </ScrollView>;
}

function BottomNav({ tab, onChange }: { tab: 'lobby' | 'history' | 'rules'; onChange: (tab: 'lobby' | 'history' | 'rules') => void }) {
  const items = [
    { key: 'lobby' as const, icon: 'grid-outline' as const, active: 'grid' as const, label: '大厅' },
    { key: 'history' as const, icon: 'time-outline' as const, active: 'time' as const, label: '战绩' },
    { key: 'rules' as const, icon: 'book-outline' as const, active: 'book' as const, label: '规则' },
  ];
  return <View accessibilityRole="tablist" style={styles.nav}>{items.map((item) => <Pressable accessibilityRole="tab" accessibilityLabel={`${item.label}标签页`} accessibilityState={{ selected: tab === item.key }} key={item.key} onPress={() => onChange(item.key)} style={styles.navItem}><Ionicons name={tab === item.key ? item.active : item.icon} size={22} color={tab === item.key ? C.lime : C.muted} /><Text style={[styles.navLabel, tab === item.key && styles.navActive]}>{item.label}</Text></Pressable>)}</View>;
}

export default function App() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [game, setGame] = useState<GameView | null>(null);
  const [room, setRoom] = useState<RoomView | null>(null);
  const [tab, setTab] = useState<'lobby' | 'history' | 'rules'>('lobby');
  const [historyData, setHistoryData] = useState<History | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('connecting');
  const [retrying, setRetrying] = useState(false);

  useEffect(() => { initialize(); }, []);
  useEffect(() => {
    if (tab !== 'history' || game) return;
    setBusy(true); history().then((data) => { setHistoryData(data); setConnectionStatus('online'); }).catch(showError).finally(() => setBusy(false));
  }, [tab, game]);
  useEffect(() => { if (!error) return; const timer = setTimeout(() => setError(null), 3200); return () => clearTimeout(timer); }, [error]);
  useRoomSync(room, {
    onRoom: (next) => { setRoom(next); setConnectionStatus('online'); },
    onGame: (next) => { setGame(next); setRoom(null); setConnectionStatus('online'); },
    onConnected: () => setConnectionStatus('online'),
    onError: (value) => { if (isConnectionIssue(value)) setConnectionStatus('offline'); },
  });
  useGameSync(game, {
    onGame: (next) => {
      setGame(next);
      setConnectionStatus('online');
      if (next.phase === 'finished') void me().then(setProfile).catch(showError);
    },
    onConnected: () => setConnectionStatus('online'),
    onError: (value) => { if (isConnectionIssue(value)) setConnectionStatus('offline'); },
  });

  function showError(value: unknown) {
    if (isConnectionIssue(value)) setConnectionStatus('offline');
    setError(value instanceof ApiError || value instanceof Error ? productCopy(value.message) : '操作失败，请重试。');
  }
  async function initialize() {
    setBusy(true); setBootError(null); setConnectionStatus('connecting');
    try {
      const nextProfile = await bootstrap();
      const resumable = await resumeSession();
      setProfile(nextProfile);
      if (resumable.game) setGame(resumable.game);
      else if (resumable.room) setRoom(resumable.room);
      setConnectionStatus('online');
    }
    catch (value) { const message = productCopy(value instanceof Error ? value.message : '暂时无法连接服务'); setBootError(message); setError(message); setConnectionStatus('offline'); }
    finally { setBusy(false); }
  }
  async function start() {
    setBusy(true); try { setGame(await quickGame()); setConnectionStatus('online'); await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium); } catch (value) { showError(value); } finally { setBusy(false); }
  }
  async function act(kind: 'bid' | 'play' | 'pass', input?: object) {
    if (!game) return;
    setBusy(true); try { const result = await gameAction(game.id, game.sequence, kind, input); setGame(result.game); setProfile(result.profile); setConnectionStatus('online'); await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); } catch (value) { showError(value); await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error); } finally { setBusy(false); }
  }
  async function relief() {
    setBusy(true); try { const result = await claimRelief(); setProfile(result.profile); setConnectionStatus('online'); setError(result.claimed ? '今日竞技分补给已到账' : '当前不满足补给条件'); } catch (value) { showError(value); } finally { setBusy(false); }
  }
  async function makeRoom() {
    setBusy(true); try {
      const next = await createRoom();
      if (next.status === 'playing' && next.gameId) setGame(await getGame(next.gameId));
      else setRoom(next);
      setConnectionStatus('online');
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    } catch (value) { showError(value); } finally { setBusy(false); }
  }
  async function enterRoom(code: string) {
    setBusy(true); try { setRoom(await joinRoom(code)); setConnectionStatus('online'); await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); } catch (value) { showError(value); } finally { setBusy(false); }
  }
  async function beginRoom() {
    if (!room) return;
    setBusy(true); try { const result = await startRoom(room.id); setRoom(null); setGame(result.game); setConnectionStatus('online'); } catch (value) { showError(value); } finally { setBusy(false); }
  }
  async function exitRoom() {
    if (!room) return;
    setBusy(true); try { await leaveRoom(room.id); setRoom(null); setConnectionStatus('online'); } catch (value) { showError(value); } finally { setBusy(false); }
  }
  async function report(reason: 'collusion' | 'cheating' | 'harassment' | 'other') {
    if (!game) return;
    setBusy(true); try { const result = await reportGame(game.id, reason); setConnectionStatus('online'); setError(result.report.created ? '举报已提交，我们会保留本局记录' : '这项举报已经提交过'); } catch (value) { showError(value); } finally { setBusy(false); }
  }
  async function shareRoomCode() {
    if (!room) return;
    try {
      const result = await Share.share({
        title: `KAI Play 好友房 ${room.code}`,
        message: `来 KAI Play 一起玩三人争先！好友房房间号：${room.code}\n竞技分仅记录游戏表现，不可购买、转让或提现。`,
      });
      if (result.action === Share.sharedAction) {
        setError('房间号已分享');
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
    } catch (value) { setError(value instanceof Error ? value.message : '暂时无法分享房间号'); }
  }
  async function retryConnection() {
    if (!profile) { await initialize(); return; }
    setRetrying(true); setConnectionStatus('connecting');
    try {
      if (game) {
        const nextGame = await getGame(game.id);
        setGame(nextGame);
        setProfile(await me());
      } else if (room) {
        const nextRoom = await getRoom(room.id);
        if (nextRoom.status === 'playing' && nextRoom.gameId) {
          setGame(await getGame(nextRoom.gameId));
          setRoom(null);
        } else setRoom(nextRoom);
      } else {
        setProfile(await me());
        if (tab === 'history') setHistoryData(await history());
      }
      setConnectionStatus('online');
      setError('网络已恢复，状态已同步');
    } catch (value) { showError(value); }
    finally { setRetrying(false); }
  }
  const title = useMemo(() => tab === 'lobby' ? '大厅' : tab === 'history' ? '战绩' : '规则', [tab]);

  return <SafeAreaProvider><LinearGradient colors={[C.deep, '#08251E']} style={styles.root}><StatusBar style="light" />
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      {profile ? <ConnectionBanner status={connectionStatus} retrying={retrying} onRetry={retryConnection} /> : null}
      {!profile ? <View style={styles.loading}><View style={styles.brandMarkLarge}><Text style={styles.brandMarkLargeText}>K</Text></View><Text style={styles.loadingBrand}>KAI PLAY</Text><Text style={styles.loadingSub}>算力局</Text>{bootError ? <><Text accessibilityRole="alert" style={styles.bootError}>{bootError}</Text><Pressable accessibilityRole="button" accessibilityLabel="重新连接牌局服务" accessibilityState={{ disabled: busy, busy }} disabled={busy} onPress={initialize} style={styles.retryButton}><Text style={styles.retryText}>重新连接</Text></Pressable></> : <ActivityIndicator accessibilityLabel="正在连接牌局服务" color={C.lime} style={{ marginTop: 24 }} />}</View> : game ? <Table game={game} profile={profile} busy={busy} onAction={act} onReport={report} onExit={() => { setGame(null); setTab('lobby'); }} /> : room ? <RoomScreen room={room} busy={busy} onStart={beginRoom} onLeave={exitRoom} onShare={shareRoomCode} /> : <>
        <AppHeader profile={profile} onHome={() => setTab('lobby')} />
        <View style={{ flex: 1 }} accessibilityLabel={title}>{tab === 'lobby' ? <Lobby profile={profile} busy={busy} onQuick={start} onRelief={relief} onCreateRoom={makeRoom} onJoinRoom={enterRoom} /> : tab === 'history' ? <HistoryScreen data={historyData} loading={busy} /> : <RulesScreen />}</View>
        <BottomNav tab={tab} onChange={setTab} />
      </>}
      {error ? <View accessibilityRole="alert" accessibilityLiveRegion="polite" style={styles.toast}><Ionicons name="information-circle" size={18} color={C.deep} /><Text style={styles.toastText}>{error}</Text></View> : null}
    </SafeAreaView>
  </LinearGradient></SafeAreaProvider>;
}

const styles = StyleSheet.create({
  root: { flex: 1 }, safe: { flex: 1 }, center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' }, loadingBrand: { color: C.ink, fontSize: 28, fontWeight: '900', marginTop: 14, letterSpacing: 3 }, loadingSub: { color: C.muted, fontSize: 11, fontWeight: '800', letterSpacing: 5, marginTop: 5, marginLeft: 5 },
  bootError: { color: C.muted, fontSize: 12, lineHeight: 19, textAlign: 'center', maxWidth: 260, marginTop: 18 }, retryButton: { marginTop: 16, height: 44, paddingHorizontal: 24, borderRadius: 14, backgroundColor: C.lime, alignItems: 'center', justifyContent: 'center' }, retryText: { color: C.deep, fontSize: 13, fontWeight: '900' },
  brandMarkLarge: { width: 72, height: 72, borderRadius: 24, backgroundColor: C.lime, alignItems: 'center', justifyContent: 'center', transform: [{ rotate: '-6deg' }] }, brandMarkLargeText: { color: C.deep, fontSize: 36, fontWeight: '900' },
  connectionBanner: { minHeight: 58, marginHorizontal: 12, marginTop: 6, borderRadius: 16, borderWidth: 1, borderColor: 'rgba(244,201,104,0.28)', backgroundColor: C.panel, paddingHorizontal: 13, paddingVertical: 9, flexDirection: 'row', alignItems: 'center', gap: 10 },
  connectionBannerOffline: { backgroundColor: C.gold, borderColor: C.gold }, connectionCopy: { flex: 1 }, connectionTitle: { color: C.ink, fontSize: 13, fontWeight: '900' }, connectionTextOffline: { color: C.deep }, connectionHint: { color: C.muted, fontSize: 10, lineHeight: 15, marginTop: 2 }, connectionHintOffline: { color: '#435048' }, connectionRetry: { minWidth: 64, minHeight: 40, paddingHorizontal: 12, borderRadius: 12, backgroundColor: C.deep, alignItems: 'center', justifyContent: 'center' }, connectionRetryText: { color: C.lime, fontSize: 12, fontWeight: '900' },
  header: { minHeight: 68, paddingHorizontal: 20, paddingVertical: 10, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.line },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: 10 }, brandMark: { width: 38, height: 38, borderRadius: 12, backgroundColor: C.lime, alignItems: 'center', justifyContent: 'center', transform: [{ rotate: '-5deg' }] }, brandMarkText: { color: C.deep, fontWeight: '900', fontSize: 20 }, brand: { color: C.ink, fontWeight: '900', fontSize: 18, letterSpacing: 2 }, brandSub: { color: C.muted, fontSize: 8, letterSpacing: 2.5, marginTop: 1 },
  balance: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.07)', borderWidth: 1, borderColor: C.line, paddingHorizontal: 11, height: 36, borderRadius: 18, gap: 6 }, scoreDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: C.gold }, balanceText: { color: C.ink, fontWeight: '800', fontVariant: ['tabular-nums'] }, balanceUnit: { color: C.muted, fontSize: 8, fontWeight: '800' },
  lobby: { padding: 20, paddingBottom: 36 }, greeting: { marginTop: 8, marginBottom: 22 }, eyebrow: { color: C.lime, fontSize: 12, fontWeight: '800', letterSpacing: 1.5, marginBottom: 8 }, heroTitle: { color: C.ink, fontSize: 32, lineHeight: 40, fontWeight: '900' }, heroCopy: { color: C.muted, fontSize: 14, marginTop: 5 },
  heroCard: { minHeight: 300, borderRadius: 28, overflow: 'hidden', borderWidth: 1, borderColor: 'rgba(183,243,93,0.22)' }, heroGlow: { position: 'absolute', width: 240, height: 240, borderRadius: 120, right: -110, top: -100, backgroundColor: 'rgba(183,243,93,0.12)' }, tableStamp: { position: 'absolute', right: 20, top: 22, width: 108, height: 136, borderRadius: 54, backgroundColor: 'rgba(4,23,19,0.65)', borderWidth: 1, borderColor: 'rgba(244,201,104,0.35)', alignItems: 'center', justifyContent: 'center' }, tableStampTop: { color: C.gold, fontSize: 10, letterSpacing: 5, marginLeft: 5 }, tableStampMain: { color: C.ink, fontSize: 56, lineHeight: 64, fontWeight: '900' }, tableStampBottom: { color: C.muted, fontSize: 10, letterSpacing: 2 }, heroBody: { padding: 24, paddingTop: 28, justifyContent: 'flex-end', flex: 1 }, pill: { alignSelf: 'flex-start', minHeight: 28, flexDirection: 'row', gap: 6, alignItems: 'center', paddingHorizontal: 10, paddingVertical: 5, borderRadius: 14, backgroundColor: 'rgba(244,201,104,0.10)', borderWidth: 1, borderColor: 'rgba(244,201,104,0.18)' }, pillLime: { backgroundColor: C.lime, borderColor: C.lime }, pillText: { color: C.gold, fontSize: 10, fontWeight: '800', flexShrink: 1 }, modeTitle: { color: C.ink, fontSize: 28, lineHeight: 36, fontWeight: '900', marginTop: 72 }, modeMeta: { color: C.muted, fontSize: 12, lineHeight: 18, marginTop: 5, marginBottom: 20 },
  primaryButton: { minHeight: 52, borderRadius: 17, backgroundColor: C.lime, paddingHorizontal: 20, paddingVertical: 10, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 9 }, primaryText: { color: C.deep, fontSize: 16, lineHeight: 22, fontWeight: '900', textAlign: 'center', flexShrink: 1 }, pressed: { transform: [{ scale: 0.985 }] },
  gameSection: { marginTop: 20 }, sectionHeadingRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }, sectionHeading: { color: C.ink, fontSize: 17, fontWeight: '900' }, sectionHint: { color: C.muted, fontSize: 9 }, gameGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 }, gameCard: { width: '48%', minHeight: 150, flexGrow: 1, borderRadius: 20, borderWidth: 1, borderColor: C.line, backgroundColor: 'rgba(255,255,255,0.025)', padding: 14, opacity: 0.72 }, gameCardAvailable: { borderColor: 'rgba(183,243,93,0.3)', backgroundColor: 'rgba(183,243,93,0.07)', opacity: 1 }, gameIcon: { width: 38, height: 38, borderRadius: 12, backgroundColor: 'rgba(255,255,255,0.06)', alignItems: 'center', justifyContent: 'center' }, gameIconAvailable: { backgroundColor: C.lime }, gameName: { color: C.ink, fontSize: 14, fontWeight: '900', marginTop: 12 }, gameCopy: { color: C.muted, fontSize: 10, lineHeight: 15, marginTop: 4, flexGrow: 1 }, gameStatus: { color: C.muted, fontSize: 9, fontWeight: '800', marginTop: 9 }, gameStatusAvailable: { color: C.lime },
  statRow: { marginTop: 16, borderWidth: 1, borderColor: C.line, backgroundColor: 'rgba(255,255,255,0.035)', borderRadius: 20, flexDirection: 'row', paddingVertical: 17 }, stat: { flex: 1, alignItems: 'center' }, statValue: { color: C.ink, fontSize: 20, fontWeight: '900', fontVariant: ['tabular-nums'] }, statLabel: { color: C.muted, fontSize: 10, marginTop: 3 }, statDivider: { width: 1, backgroundColor: C.line, marginVertical: 4 },
  friendCard: { marginTop: 16, borderRadius: 22, borderWidth: 1, borderColor: C.line, backgroundColor: 'rgba(255,255,255,0.035)', padding: 16 }, friendHeading: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }, friendTitle: { color: C.ink, fontSize: 15, fontWeight: '900' }, friendCopy: { color: C.muted, fontSize: 10, lineHeight: 15, marginTop: 4 }, friendActions: { marginTop: 15, gap: 10 }, createRoomButton: { minHeight: 44, paddingVertical: 9, borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.08)', borderWidth: 1, borderColor: C.line, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 7 }, createRoomText: { color: C.ink, fontSize: 13, fontWeight: '800' }, joinBox: { minHeight: 46, flexDirection: 'row', borderRadius: 14, borderWidth: 1, borderColor: C.line, overflow: 'hidden' }, roomInput: { flex: 1, color: C.ink, paddingHorizontal: 14, paddingVertical: 8, fontSize: 13, letterSpacing: 1 }, joinButton: { minWidth: 66, paddingHorizontal: 10, backgroundColor: C.gold, alignItems: 'center', justifyContent: 'center' }, joinText: { color: C.deep, fontSize: 12, fontWeight: '900' },
  reliefCard: { marginTop: 16, minHeight: 76, borderRadius: 19, borderWidth: 1, borderColor: 'rgba(244,201,104,0.25)', backgroundColor: 'rgba(244,201,104,0.07)', flexDirection: 'row', alignItems: 'center', padding: 14, gap: 12 }, reliefIcon: { width: 44, height: 44, borderRadius: 14, backgroundColor: 'rgba(244,201,104,0.11)', alignItems: 'center', justifyContent: 'center' }, reliefTitle: { color: C.ink, fontWeight: '800', fontSize: 14 }, reliefCopy: { color: C.muted, fontSize: 11, marginTop: 4 },
  policyCard: { marginTop: 16, minHeight: 72, borderRadius: 19, backgroundColor: 'rgba(183,243,93,0.06)', flexDirection: 'row', alignItems: 'center', padding: 16, gap: 13 }, policyTitle: { color: C.ink, fontWeight: '800', fontSize: 13 }, policyCopy: { color: C.muted, fontSize: 10, marginTop: 5 },
  computeCard: { marginTop: 16, borderRadius: 22, borderWidth: 1, borderColor: 'rgba(244,201,104,0.22)', backgroundColor: 'rgba(244,201,104,0.055)', padding: 17 }, computeTop: { flexDirection: 'row', alignItems: 'center', gap: 12 }, computeIcon: { width: 42, height: 42, borderRadius: 14, backgroundColor: 'rgba(244,201,104,0.11)', alignItems: 'center', justifyContent: 'center' }, computeTitle: { color: C.ink, fontSize: 15, fontWeight: '900' }, computeBadge: { color: C.gold, fontSize: 9, fontWeight: '800', marginTop: 4 }, computeCopy: { color: C.muted, fontSize: 11, lineHeight: 18, marginTop: 13 }, computeTags: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, marginTop: 12 }, computeTag: { minHeight: 28, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 14, borderWidth: 1, borderColor: C.line, backgroundColor: 'rgba(255,255,255,0.035)' }, computeTagText: { color: C.ink, fontSize: 9, fontWeight: '800' }, computeNotice: { color: C.muted, fontSize: 9, marginTop: 13 },
  roomPage: { flexGrow: 1, paddingHorizontal: 20, paddingBottom: 24 }, roomTop: { minHeight: 60, paddingVertical: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, roomTopTitle: { color: C.ink, fontSize: 15, fontWeight: '900' }, roomCodeCard: { marginTop: 12, borderRadius: 26, padding: 20, alignItems: 'center', backgroundColor: '#123A30', borderWidth: 1, borderColor: 'rgba(183,243,93,0.20)' }, roomCodeLabel: { color: C.muted, fontSize: 10, letterSpacing: 3 }, roomCode: { width: '100%', color: C.lime, textAlign: 'center', fontSize: 42, fontWeight: '900', letterSpacing: 8, marginLeft: 8, marginTop: 8, fontVariant: ['tabular-nums'] }, roomCodeHint: { color: C.muted, fontSize: 10, lineHeight: 15, textAlign: 'center', marginTop: 8 }, shareRoomButton: { minHeight: 42, marginTop: 14, paddingHorizontal: 18, paddingVertical: 8, borderRadius: 13, backgroundColor: C.gold, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7 }, shareRoomText: { color: C.deep, fontSize: 12, fontWeight: '900' }, roomPlayers: { flexDirection: 'row', gap: 8, marginTop: 18 }, roomPlayer: { flex: 1, minHeight: 142, borderRadius: 20, alignItems: 'center', padding: 10, backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: C.line }, roomPlayerEmpty: { borderStyle: 'dashed', backgroundColor: 'transparent' }, roomAvatar: { width: 48, height: 48, borderRadius: 24, backgroundColor: C.gold, alignItems: 'center', justifyContent: 'center', marginTop: 4 }, roomPlayerName: { color: C.ink, fontSize: 11, lineHeight: 16, fontWeight: '800', marginTop: 12, textAlign: 'center' }, roomPlayerMeta: { color: C.muted, fontSize: 9, lineHeight: 14, marginTop: 5, textAlign: 'center' }, roomNotice: { marginTop: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7 }, roomNoticeText: { color: C.muted, fontSize: 10, lineHeight: 15, flexShrink: 1 }, waitHost: { minHeight: 52, paddingVertical: 9, borderRadius: 17, borderWidth: 1, borderColor: C.line, flexDirection: 'row', gap: 10, alignItems: 'center', justifyContent: 'center' }, waitHostText: { color: C.ink, fontWeight: '800', fontSize: 13 }, roomPolicy: { color: C.muted, fontSize: 9, lineHeight: 14, textAlign: 'center', marginTop: 12 },
  nav: { minHeight: 70, paddingTop: 6, paddingBottom: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.line, flexDirection: 'row', backgroundColor: 'rgba(4,23,19,0.96)' }, navItem: { flex: 1, minHeight: 52, alignItems: 'center', justifyContent: 'center', gap: 4 }, navLabel: { color: C.muted, fontSize: 10, fontWeight: '700' }, navActive: { color: C.lime },
  tablePage: { flex: 1 }, tableTopbar: { minHeight: 60, paddingVertical: 7, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14 }, circleButton: { width: 42, height: 42, borderRadius: 21, backgroundColor: 'rgba(255,255,255,0.07)', alignItems: 'center', justifyContent: 'center' }, tableMeta: { flex: 1, alignItems: 'center', paddingHorizontal: 8 }, tableMetaTop: { color: C.ink, fontSize: 14, fontWeight: '800' }, tableMetaBottom: { color: C.muted, fontSize: 10, lineHeight: 14, textAlign: 'center', marginTop: 3 },
  reportMenu: { position: 'absolute', zIndex: 30, right: 14, top: 54, width: 172, borderRadius: 17, padding: 8, backgroundColor: '#16372F', borderWidth: 1, borderColor: C.line, shadowColor: '#000', shadowOpacity: 0.35, shadowRadius: 12, elevation: 10 }, reportMenuTitle: { color: C.muted, fontSize: 9, fontWeight: '800', paddingHorizontal: 10, paddingVertical: 7 }, reportOption: { height: 39, borderRadius: 11, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, reportOptionText: { color: C.ink, fontSize: 12, fontWeight: '700' },
  opponentsRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 12, marginBottom: 8 }, opponent: { flex: 1, minHeight: 64, borderWidth: 1, borderColor: C.line, backgroundColor: 'rgba(255,255,255,0.035)', borderRadius: 16, padding: 9, flexDirection: 'row', alignItems: 'center', gap: 8 }, opponentActive: { borderColor: C.lime, backgroundColor: 'rgba(183,243,93,0.07)' }, avatar: { width: 34, height: 34, borderRadius: 17, backgroundColor: C.gold, alignItems: 'center', justifyContent: 'center' }, opponentNameRow: { flexDirection: 'row', alignItems: 'center', gap: 4 }, opponentName: { color: C.ink, fontSize: 11, fontWeight: '800', flexShrink: 1 }, opponentMeta: { color: C.muted, fontSize: 9, lineHeight: 13, marginTop: 3 }, role: { color: C.lime, fontSize: 8, fontWeight: '900', borderRadius: 4, overflow: 'hidden' }, roleLandlord: { color: C.gold }, backCards: { flexDirection: 'row', alignItems: 'center' }, cardBack: { width: 17, height: 25, borderRadius: 4, backgroundColor: '#C95B4E', borderWidth: 1, borderColor: 'rgba(255,255,255,0.5)' }, cardCount: { color: C.ink, fontSize: 10, fontWeight: '900', marginLeft: 4 },
  felt: { flex: 1, marginHorizontal: 10, borderRadius: 28, borderWidth: 1, borderColor: 'rgba(183,243,93,0.13)', backgroundColor: '#0A3A2E', overflow: 'hidden', minHeight: 325 }, bottomCards: { minHeight: 64, paddingVertical: 8, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 4 }, bottomLabel: { color: C.muted, fontSize: 9, marginRight: 4 }, mysteryCard: { width: 29, height: 42, borderRadius: 6, backgroundColor: '#B94E43', borderWidth: 1, borderColor: 'rgba(255,255,255,0.45)' }, playZone: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 10 }, leadBy: { color: C.gold, fontSize: 10, fontWeight: '800', marginBottom: 7 }, leadCards: { flexDirection: 'row', justifyContent: 'center' }, turnPrompt: { flexDirection: 'row', gap: 8, alignItems: 'center' }, turnPulse: { width: 7, height: 7, borderRadius: 4, backgroundColor: C.lime }, turnText: { color: C.muted, fontSize: 12 }, turnTimer: { minHeight: 34, paddingHorizontal: 12, paddingVertical: 6, marginBottom: 10, borderRadius: 17, borderWidth: 1, borderColor: 'rgba(244,201,104,0.24)', backgroundColor: 'rgba(4,23,19,0.62)', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5 }, turnTimerUrgent: { backgroundColor: C.gold, borderColor: C.gold }, turnTimerValue: { color: C.gold, fontSize: 16, fontWeight: '900', fontVariant: ['tabular-nums'] }, turnTimerValueUrgent: { color: C.deep }, turnTimerUnit: { color: C.muted, fontSize: 9, fontWeight: '800' }, turnUrgentText: { color: C.gold, fontWeight: '900' },
  bidPanel: { padding: 15 }, actionPanel: { padding: 15 }, actionHint: { color: C.muted, fontSize: 10, lineHeight: 15, textAlign: 'center', marginBottom: 9 }, actionRow: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 9 }, secondaryButton: { minWidth: 76, minHeight: 44, paddingHorizontal: 13, paddingVertical: 9, borderRadius: 14, borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)', backgroundColor: 'rgba(255,255,255,0.07)', alignItems: 'center', justifyContent: 'center' }, secondaryText: { color: C.ink, fontSize: 13, fontWeight: '800' }, bidButton: { minWidth: 68, minHeight: 44, paddingHorizontal: 12, paddingVertical: 9, borderRadius: 14, backgroundColor: C.gold, alignItems: 'center', justifyContent: 'center' }, bidText: { color: C.deep, fontSize: 13, fontWeight: '900' }, playButton: { minWidth: 110, minHeight: 44, paddingHorizontal: 16, paddingVertical: 9, borderRadius: 14, backgroundColor: C.lime, alignItems: 'center', justifyContent: 'center' }, playText: { color: C.deep, fontSize: 14, fontWeight: '900' }, disabled: { opacity: 0.3 },
  myInfo: { paddingHorizontal: 16, paddingTop: 10, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, myName: { color: C.ink, fontSize: 12, fontWeight: '800' }, myBalance: { color: C.gold, fontSize: 9, marginTop: 3 }, handCount: { color: C.muted, fontSize: 10 }, hand: { paddingHorizontal: 14, paddingTop: 18, paddingBottom: 12, minWidth: '100%', justifyContent: 'center', alignItems: 'flex-end' },
  card: { width: 49, height: 74, borderRadius: 8, backgroundColor: C.white, borderWidth: 1, borderColor: '#D9D2C5', padding: 5, shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 3, shadowOffset: { width: 0, height: 2 }, elevation: 3 }, cardSelected: { transform: [{ translateY: -14 }], borderColor: C.lime, borderWidth: 2, backgroundColor: '#F7FFE9' }, cardSmall: { width: 31, height: 45, borderRadius: 6, padding: 3 }, cardRank: { color: C.black, fontSize: 16, lineHeight: 18, fontWeight: '900' }, cardRankSmall: { fontSize: 9, lineHeight: 11 }, cardSuit: { color: C.black, fontSize: 18, lineHeight: 20 }, cardSuitSmall: { fontSize: 10, lineHeight: 11 }, cardRed: { color: '#D84942' },
  resultShade: { position: 'absolute', inset: 0, zIndex: 20, backgroundColor: 'rgba(2,12,10,0.78)', alignItems: 'center', justifyContent: 'center', padding: 28 }, resultCard: { width: '100%', borderRadius: 28, backgroundColor: '#12342B', borderWidth: 1, borderColor: 'rgba(183,243,93,0.3)', padding: 26, alignItems: 'center' }, resultEyebrow: { color: C.gold, fontSize: 11, fontWeight: '900', letterSpacing: 2 }, resultTitle: { color: C.ink, fontSize: 34, fontWeight: '900', marginTop: 10 }, resultDelta: { color: C.lime, fontSize: 30, fontWeight: '900', marginVertical: 12 }, resultUnit: { fontSize: 12 }, resultMeta: { color: C.muted, fontSize: 11, marginBottom: 5 }, fairnessCode: { color: '#74867D', fontSize: 9, fontFamily: 'monospace', marginBottom: 22 },
  contentPage: { padding: 20, paddingBottom: 36 }, pageEyebrow: { color: C.lime, fontSize: 10, fontWeight: '900', letterSpacing: 3, marginTop: 10 }, pageTitle: { color: C.ink, fontSize: 30, fontWeight: '900', marginTop: 7, marginBottom: 24 }, pageIntro: { color: C.muted, fontSize: 14, lineHeight: 22, marginTop: -15, marginBottom: 24 }, sectionTitle: { color: C.ink, fontSize: 14, fontWeight: '900', marginBottom: 12 }, empty: { minHeight: 120, borderRadius: 20, borderWidth: 1, borderStyle: 'dashed', borderColor: C.line, alignItems: 'center', justifyContent: 'center', gap: 9 }, emptyText: { color: C.muted, fontSize: 12 },
  historyRow: { minHeight: 68, flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.line, gap: 12 }, historyIcon: { width: 38, height: 38, borderRadius: 12, alignItems: 'center', justifyContent: 'center' }, historyWin: { backgroundColor: 'rgba(183,243,93,0.09)' }, historyLose: { backgroundColor: 'rgba(230,99,90,0.09)' }, historyTitle: { color: C.ink, fontSize: 13, fontWeight: '800' }, historyDate: { color: C.muted, fontSize: 9, marginTop: 4 }, historyDelta: { color: C.lime, fontWeight: '900', fontSize: 15 }, ledgerRow: { minHeight: 58, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.line }, ledgerMemo: { color: C.ink, fontSize: 12, fontWeight: '700' }, ledgerAmount: { color: C.lime, fontSize: 13, fontWeight: '900' },
  ruleRow: { flexDirection: 'row', gap: 16, paddingVertical: 18, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.line }, ruleIndex: { color: C.lime, fontSize: 11, fontWeight: '900', letterSpacing: 1 }, ruleTitle: { color: C.ink, fontSize: 15, fontWeight: '900' }, ruleCopy: { color: C.muted, fontSize: 12, lineHeight: 19, marginTop: 7 }, fairCard: { marginTop: 22, borderRadius: 22, padding: 20, borderWidth: 1, borderColor: 'rgba(183,243,93,0.2)', backgroundColor: 'rgba(183,243,93,0.06)' }, fairTitle: { color: C.ink, fontSize: 16, fontWeight: '900', marginTop: 12 }, fairCopy: { color: C.muted, fontSize: 12, lineHeight: 19, marginTop: 8 },
  toast: { position: 'absolute', left: 24, right: 24, bottom: 82, minHeight: 48, borderRadius: 15, paddingHorizontal: 14, backgroundColor: C.gold, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, shadowColor: '#000', shadowOpacity: 0.35, shadowRadius: 12, elevation: 8 }, toastText: { color: C.deep, fontWeight: '800', fontSize: 12, flexShrink: 1 },
});
