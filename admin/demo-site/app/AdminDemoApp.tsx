'use client';

import { useEffect, useState } from 'react';
import { BrowserRouter } from 'react-router-dom';
import { App } from '../../src/App';
import { AuthProvider } from '../../src/auth/AuthContext';

export function AdminDemoApp() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  if (!mounted) return <main className="state-screen">正在加载 KAI 管理控制台演示…</main>;
  return <BrowserRouter><AuthProvider><App /></AuthProvider></BrowserRouter>;
}
