import type { ReactNode } from 'react';
import '../../src/styles.css';

export const metadata = {
  title: 'KAI 管理控制台演示',
  description: 'KAI 管理员后台的只读产品演示，全部使用模拟数据。',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
