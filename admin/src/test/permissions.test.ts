import { describe, expect, it } from 'vitest';
import { can, PERMISSIONS } from '../auth/permissions';

describe('console permissions', () => {
  it('does not treat super_admin role names as implicit page access', () => {
    expect(can(['admin.overview.read', 'super_admin'], PERMISSIONS.payouts)).toBe(false);
  });

  it('grants each page only from the backend permission snapshot', () => {
    expect(can(['admin.payout.read'], PERMISSIONS.payouts)).toBe(true);
    expect(can(['admin.payout.read'], PERMISSIONS.topups)).toBe(false);
  });
});
