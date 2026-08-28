import { LinearGradient } from 'expo-linear-gradient';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useEffect, useState, type ReactNode } from 'react';
import { AccessibilityInfo, AppState, Image, StyleSheet, Text, View } from 'react-native';

export const topVideoColors = Object.freeze({
  primary: '#1976D2', canvas: '#F5F9FC', surface: '#FFFFFF', ink: '#132B3D', muted: '#5A7188', line: '#C7D7E1', focus: '#F1934A',
});

const serverRoomVideo = require('../../docs/design-previews/mobile-20260823/server-room-preview.mp4');
const serverRoomPoster = require('../../docs/design-previews/mobile-20260823/server-room-poster.jpg');
const f1Icon = require('../../assets/icon.png');
const absoluteFillObject = Object.freeze({ position: 'absolute' as const, top: 0, right: 0, bottom: 0, left: 0 });

type Props = Readonly<{
  eyebrow: string;
  title: string;
  detail?: string;
  children?: ReactNode;
}>;

/** Decorative local media only: callers retain every status, action, and business decision. */
export function TopVideoHero({ eyebrow, title, detail, children }: Props) {
  const [appState, setAppState] = useState(AppState.currentState);
  const [reduceMotion, setReduceMotion] = useState<boolean | null>(null);
  const player = useVideoPlayer(serverRoomVideo, (instance) => {
    instance.loop = true;
    instance.muted = true;
  });
  // Poster-first: never start motion before the platform preference has resolved.
  const shouldPlay = appState === 'active' && reduceMotion === false;

  useEffect(() => {
    let mounted = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((enabled) => {
      if (mounted) setReduceMotion(enabled);
    });
    const motionSubscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    const appStateSubscription = AppState.addEventListener('change', setAppState);
    return () => {
      mounted = false;
      motionSubscription.remove();
      appStateSubscription.remove();
    };
  }, []);

  useEffect(() => {
    if (shouldPlay) player.play();
    else player.pause();
  }, [player, shouldPlay]);

  return <View style={styles.hero}>
    <Image source={serverRoomPoster} resizeMode="cover" style={styles.poster} accessible={false} />
    {shouldPlay ? <VideoView player={player} nativeControls={false} contentFit="cover" style={styles.video} accessible={false} /> : null}
    <LinearGradient colors={['rgba(8, 30, 48, 0.68)', 'rgba(19, 43, 61, 0.24)', 'rgba(19, 43, 61, 0.78)']} locations={[0, 0.48, 1]} style={styles.scrim} pointerEvents="none" />
    <View style={styles.content}>
      <View style={styles.brandRow}><Image source={f1Icon} style={styles.f1Icon} accessible={false} /><View><Text style={styles.brand}>KAI CloudPay</Text><Text style={styles.eyebrow}>{eyebrow}</Text></View></View>
      <View style={styles.copy}><Text style={styles.title}>{title}</Text>{detail ? <Text style={styles.detail}>{detail}</Text> : null}</View>
      {children ? <View style={styles.footer}>{children}</View> : null}
    </View>
  </View>;
}

const styles = StyleSheet.create({
  hero: { minHeight: 168, borderRadius: 24, overflow: 'hidden', backgroundColor: topVideoColors.ink, shadowColor: '#0B3553', shadowOpacity: 0.16, shadowRadius: 16, shadowOffset: { width: 0, height: 8 }, elevation: 4 },
  poster: { ...absoluteFillObject },
  video: { ...absoluteFillObject }, scrim: { ...absoluteFillObject },
  content: { flex: 1, minHeight: 168, padding: 17, justifyContent: 'space-between' },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: 8 }, f1Icon: { width: 28, height: 28, borderRadius: 8 },
  brand: { color: topVideoColors.surface, fontSize: 12, fontWeight: '900', letterSpacing: 0.2 }, eyebrow: { color: '#D8E7F1', fontSize: 9, fontWeight: '800', marginTop: 1 },
  copy: { marginTop: 12 }, title: { color: topVideoColors.surface, fontSize: 24, lineHeight: 31, fontWeight: '900', letterSpacing: -0.4 }, detail: { color: '#E2EEF5', fontSize: 11, lineHeight: 17, marginTop: 5, maxWidth: '92%' },
  footer: { marginTop: 13 },
});
