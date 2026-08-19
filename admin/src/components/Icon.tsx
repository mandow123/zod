import type { SVGProps } from 'react';

export type IconName = 'dashboard' | 'compute' | 'device' | 'payout' | 'topup' | 'shield' | 'menu' | 'close' | 'logout' | 'refresh' | 'search' | 'arrow';

const paths: Record<IconName, React.ReactNode> = {
  dashboard: <><rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/></>,
  compute: <><rect x="3" y="5" width="18" height="14" rx="3"/><path d="M8 9h8M8 13h5M8 17h8"/><path d="M7 2v3M17 2v3M7 19v3M17 19v3"/></>,
  device: <><rect x="6" y="2" width="12" height="20" rx="3"/><path d="M10 5h4M10 18h4"/></>,
  payout: <><path d="M3 7h18M5 7l2-4h10l2 4v14H5Z"/><path d="M8 12h8M12 9v6"/></>,
  topup: <><rect x="3" y="6" width="18" height="14" rx="3"/><path d="M3 10h18M16 15h2"/><path d="M8 2v4M5 4h6"/></>,
  shield: <><path d="M12 2 4 5v6c0 5.2 3.4 9 8 11 4.6-2 8-5.8 8-11V5Z"/><path d="m9 12 2 2 4-5"/></>,
  menu: <path d="M4 7h16M4 12h16M4 17h16"/>,
  close: <path d="m6 6 12 12M18 6 6 18"/>,
  logout: <><path d="M10 4H5v16h5M14 8l4 4-4 4M9 12h9"/></>,
  refresh: <><path d="M20 7v5h-5"/><path d="M18.5 9A8 8 0 1 0 20 15"/></>,
  search: <><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></>,
  arrow: <path d="m9 18 6-6-6-6"/>,
};

export function Icon({ name, ...props }: SVGProps<SVGSVGElement> & { name: IconName }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...props}>
      {paths[name]}
    </svg>
  );
}
