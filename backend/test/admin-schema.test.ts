import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { adminFixture, h128, h64 } from './admin-test-database.js';

describe('admin persistence schema', () => {
  it('creates the empty admin tables and token registry without touching mobile identities', { timeout: 120_000 }, async () => {
    const f = await adminFixture();
    const names = ['admin_identities','admin_role_assignments','admin_sessions','admin_session_token_hashes',
      'admin_login_transactions','admin_audit_events'];
    for (const name of names) {
      const result = await f.database.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${name}`);
      expect(result.rows[0]?.count).toBe('0');
    }
    const mobile = await f.database.query<{ count: string }>('SELECT count(*)::text AS count FROM mobile_sessions');
    expect(mobile.rows[0]?.count).toBe('0');
    await f.database.close();
  });
  it('enforces identity, assignment, session, transaction and immutable audit constraints', { timeout: 120_000 }, async () => {
    const f = await adminFixture(); const now = new Date(); const adminId = randomUUID(); const otherId = randomUUID();
    await f.database.query(`INSERT INTO admin_identities(id,issuer,subject_hash,display_name,status,created_at,updated_at)
      VALUES ($1,'https://auth.kai.com',$2,'Admin','active',$3,$3),($4,'https://auth.kai.com',$5,'Other','active',$3,$3)`,
    [adminId,h128('a'),now,otherId,h128('b')]);
    await expect(f.database.query(`INSERT INTO admin_identities(id,issuer,subject_hash,display_name,status)
      VALUES ($1,'https://auth.kai.com',$2,'Duplicate','active')`, [randomUUID(),h128('a')])).rejects.toThrow();
    await expect(f.database.query(`UPDATE admin_identities SET status='invalid' WHERE id=$1`, [adminId])).rejects.toThrow();
    await expect(f.database.query(`INSERT INTO admin_role_assignments(id,admin_identity_id,role_code,source,
      valid_from,granted_by_admin_id) VALUES ($1,$2,'root','manual',$3,$4)`,
    [randomUUID(),adminId,now,otherId])).rejects.toThrow();
    await expect(f.database.query(`INSERT INTO admin_role_assignments(id,admin_identity_id,role_code,source,valid_from)
      VALUES ($1,$2,'audit_viewer','invalid',$3)`, [randomUUID(),adminId,now])).rejects.toThrow();
    await expect(f.database.query(`INSERT INTO admin_role_assignments(id,admin_identity_id,role_code,source,valid_from)
      VALUES ($1,$2,'audit_viewer','manual',$3)`, [randomUUID(),adminId,now])).rejects.toThrow();
    await expect(f.database.query(`INSERT INTO admin_role_assignments(id,admin_identity_id,role_code,source,
      valid_from,granted_by_admin_id) VALUES ($1,$2,'audit_viewer','manual',$3,$2)`,
    [randomUUID(),adminId,now])).rejects.toThrow();
    const absolute = new Date(now.getTime() + 60_000); const sessionId = randomUUID();
    await f.database.query(`INSERT INTO admin_sessions(id,admin_identity_id,token_hash,csrf_token_hash,status,
      authz_version_at_issue,permission_definition_version,permission_snapshot_digest,created_at,last_seen_at,
      idle_expires_at,absolute_expires_at,created_ip_hash,last_ip_hash,user_agent_hash)
      VALUES ($1,$2,$3,$4,'active',1,'v1',$5,$6,$6,$7,$7,$8,$8,$8)`,
    [sessionId,adminId,h128('c'),h128('d'),h128('e'),now,absolute,h64('f')]);
    expect((await f.database.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM admin_session_token_hashes WHERE admin_session_id=$1', [sessionId],
    )).rows[0]?.count).toBe('1');
    await expect(f.database.query(`UPDATE admin_sessions SET status='invalid' WHERE id=$1`, [sessionId])).rejects.toThrow();
    await expect(f.database.query(`UPDATE admin_sessions SET previous_token_hash=$2,
      previous_token_valid_until=$3 WHERE id=$1`, [sessionId,h128('z'),new Date(now.getTime()+1_000)])).rejects.toThrow();
    const rotatedAt = new Date(now.getTime()+1_000); const previousValidUntil = new Date(now.getTime()+2_000);
    await f.database.query(`UPDATE admin_sessions SET previous_token_hash=token_hash,
      previous_token_valid_until=$2,token_hash=$3,rotated_at=$4 WHERE id=$1`,
    [sessionId,previousValidUntil,h128('z'),rotatedAt]);
    expect((await f.database.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM admin_session_token_hashes WHERE admin_session_id=$1', [sessionId],
    )).rows[0]?.count).toBe('2');
    await expect(f.database.query(`INSERT INTO admin_sessions(id,admin_identity_id,token_hash,csrf_token_hash,status,
      authz_version_at_issue,permission_definition_version,permission_snapshot_digest,created_at,last_seen_at,
      idle_expires_at,absolute_expires_at,created_ip_hash,last_ip_hash,user_agent_hash)
      VALUES ($1,$2,$3,$4,'active',1,'v1',$5,$6,$6,$7,$7,$8,$8,$8)`,
    [randomUUID(),adminId,h128('c'),h128('g'),h128('h'),now,absolute,h64('i')])).rejects.toThrow();
    expect((await f.database.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM admin_sessions WHERE token_hash=$1', [h128('c')],
    )).rows[0]?.count).toBe('0');
    await expect(f.database.query('DELETE FROM admin_sessions WHERE id=$1',[sessionId])).rejects.toThrow();
    expect((await f.database.query('DELETE FROM admin_session_token_hashes WHERE valid_until <= $1',
      [new Date(previousValidUntil.getTime()-1)])).rowCount).toBe(0);
    expect((await f.database.query('DELETE FROM admin_session_token_hashes WHERE valid_until <= $1',
      [previousValidUntil])).rowCount).toBe(1);
    await expect(f.database.query('UPDATE admin_sessions SET idle_expires_at=$2 WHERE id=$1',
      [sessionId,new Date(absolute.getTime()+1)])).rejects.toThrow();
    await f.database.query(`INSERT INTO admin_login_transactions(id,state_hash,browser_binding_hash,nonce_hash,
      pkce_verifier_ciphertext,return_path,expires_at,created_ip_hash,user_agent_hash,created_at)
      VALUES ($1,$2,$3,$4,'cipher','/',$5,$6,$6,$7)`,
    [randomUUID(),h128('j'),h128('k'),h128('l'),absolute,h64('m'),now]);
    await expect(f.database.query(`INSERT INTO admin_login_transactions(id,state_hash,browser_binding_hash,nonce_hash,
      pkce_verifier_ciphertext,return_path,expires_at,created_ip_hash,user_agent_hash,created_at)
      VALUES ($1,$2,$3,$4,'cipher','/',$5,$6,$6,$7)`,
    [randomUUID(),h128('j'),h128('n'),h128('o'),absolute,h64('p'),now])).rejects.toThrow();
    const eventId = randomUUID();
    await f.database.query(`INSERT INTO admin_audit_events(id,occurred_at,effective_permissions,
      permission_snapshot_digest,action,request_id,outcome) VALUES ($1,$2,'[]',$3,'test',$4,'succeeded')`,
    [eventId,now,h128('q'),'request']);
    await expect(f.database.query('UPDATE admin_audit_events SET action=$2 WHERE id=$1',[eventId,'changed'])).rejects.toThrow();
    await expect(f.database.query('DELETE FROM admin_audit_events WHERE id=$1',[eventId])).rejects.toThrow();
    await f.database.close();
  });
});
