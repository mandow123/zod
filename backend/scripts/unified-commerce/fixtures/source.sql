PRAGMA foreign_keys=ON;
CREATE TABLE users(
  id TEXT PRIMARY KEY, account TEXT, email TEXT, display_name TEXT, role TEXT NOT NULL,
  enterprise_status TEXT NOT NULL, lifecycle_status TEXT NOT NULL, supplier_capability_level TEXT NOT NULL
);
CREATE TABLE external_identities(provider TEXT NOT NULL, subject TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id));
CREATE TABLE listings(
  id TEXT PRIMARY KEY, supplier_user_id TEXT NOT NULL REFERENCES users(id), kind TEXT NOT NULL,
  product_code TEXT NOT NULL, gpu TEXT NOT NULL, provider TEXT NOT NULL, region TEXT NOT NULL,
  unit TEXT NOT NULL, unit_price_cents INTEGER NOT NULL, verified_quantity INTEGER NOT NULL,
  quote_reserved INTEGER NOT NULL, order_locked INTEGER NOT NULL, delivering INTEGER NOT NULL,
  consumed INTEGER NOT NULL, frozen INTEGER NOT NULL, status TEXT NOT NULL, version INTEGER NOT NULL,
  minimum_quantity INTEGER NOT NULL, trade_mode TEXT NOT NULL, checkout_url TEXT, license_number TEXT
);
CREATE TABLE orders(
  id TEXT PRIMARY KEY, buyer_user_id TEXT NOT NULL REFERENCES users(id), listing_id TEXT NOT NULL REFERENCES listings(id),
  quantity INTEGER NOT NULL, unit TEXT NOT NULL, unit_price_cents INTEGER NOT NULL, amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL, status TEXT NOT NULL, payment_provider TEXT NOT NULL, kind TEXT NOT NULL,
  product_code TEXT NOT NULL, settlement_mode TEXT NOT NULL, buyer_claims TEXT
);
CREATE TABLE payments(
  id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id), provider TEXT NOT NULL,
  amount_cents INTEGER NOT NULL, currency TEXT NOT NULL, provider_txn_id TEXT, status TEXT NOT NULL,
  gateway TEXT NOT NULL, channel TEXT NOT NULL, provider_status TEXT NOT NULL, query_attempts INTEGER NOT NULL,
  raw_callback TEXT, merchant_key TEXT
);
CREATE TABLE allocations(
  id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL REFERENCES users(id), order_id TEXT NOT NULL REFERENCES orders(id),
  listing_id TEXT NOT NULL REFERENCES listings(id), quantity INTEGER NOT NULL, unit TEXT NOT NULL,
  status TEXT NOT NULL, kind TEXT NOT NULL, product_code TEXT NOT NULL, swap_reserved INTEGER NOT NULL
);
CREATE TABLE settlements(
  id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id), supplier_user_id TEXT NOT NULL REFERENCES users(id),
  gross_cents INTEGER NOT NULL, platform_fee_cents INTEGER NOT NULL, supplier_net_cents INTEGER NOT NULL,
  referral_commission_cents INTEGER NOT NULL, currency TEXT NOT NULL, status TEXT NOT NULL
);
WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<15)
INSERT INTO users SELECT printf('u%02d',n), 'ACCOUNT_SENTINEL_'||n, 'PII_SENTINEL_'||n||'@example.invalid',
  'NAME_SENTINEL_'||n, CASE WHEN n<=3 THEN 'supplier' ELSE 'buyer' END,
  'unverified','active',CASE WHEN n<=3 THEN 'legacy' ELSE 'none' END FROM seq;
INSERT INTO external_identities VALUES
  ('kai_identity','SUBJECT_SENTINEL_01','u01'),('kai_identity','SUBJECT_SENTINEL_02','u02'),
  ('kai_identity','SUBJECT_SENTINEL_03','u03'),('kai_identity','SUBJECT_SENTINEL_04','u04');
WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<25)
INSERT INTO listings SELECT printf('l%02d',n),printf('u%02d',1+((n-1)%3)),'gpu','GPU-'||n,'H100','legacy-provider',
  'cn','gpu_hour',100+n,10,0,0,0,0,0,'listed',1,1,'inquiry','CHECKOUT_URL_SENTINEL','LICENSE_SENTINEL' FROM seq;
INSERT INTO orders VALUES
  ('o01','u04','l01',2,'gpu_hour',101,202,'CNY','pending','qixiang','gpu','GPU-1','manual','CLAIMS_SENTINEL'),
  ('o02','u05','l02',3,'gpu_hour',102,306,'CNY','completed','qixiang','gpu','GPU-2','manual','CLAIMS_SENTINEL');
INSERT INTO payments VALUES
  ('OUTTRADE_SENTINEL_01','o01','qixiang',202,'CNY','TRADE_SENTINEL_01','pending','qixiang','alipay','0',1,'RAW_SENTINEL','KEY_SENTINEL'),
  ('OUTTRADE_SENTINEL_02','o02','qixiang',306,'CNY','TRADE_SENTINEL_02','paid','qixiang','alipay','1',1,'RAW_SENTINEL','KEY_SENTINEL');
INSERT INTO allocations VALUES('a01','u04','o01','l01',2,'gpu_hour','reserved','gpu','GPU-1',0);
INSERT INTO settlements VALUES('s01','o02','u02',306,30,260,16,'CNY','recorded');
