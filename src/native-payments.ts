import { NativeModules, Platform } from 'react-native';

type NativePaymentBridge = Readonly<{
  payAlipay: (orderInfo: string) => Promise<{ resultStatus: string; memo: string; result: string }>;
  payWechat: (checkoutPayload: string) => Promise<{ errCode: number; errStr: string }>;
}>;

const bridge = NativeModules.KaiPayments as NativePaymentBridge | undefined;

function available() {
  if (Platform.OS !== 'android' || !bridge) throw new Error('当前安装包不支持此支付方式，请更新 App。');
  return bridge;
}

export function launchNativeTopup(provider: 'alipay' | 'wechat', checkoutPayload: string) {
  if (!checkoutPayload) throw new Error('充值参数尚未生成，请重新发起充值。');
  return provider === 'alipay'
    ? available().payAlipay(checkoutPayload)
    : available().payWechat(checkoutPayload);
}
