-- Qixiang is an additive fiat top-up rail. Existing Alipay/WeChat rows and the
-- legacy reversal domain remain unchanged.
ALTER TABLE kai_credit_topups DROP CONSTRAINT kai_credit_topups_provider_check;
ALTER TABLE kai_credit_topups ADD CONSTRAINT kai_credit_topups_provider_check CHECK(provider IN('alipay','wechat','qixiang'));
ALTER TABLE kai_credit_topup_events DROP CONSTRAINT kai_credit_topup_events_provider_check;
ALTER TABLE kai_credit_topup_events ADD CONSTRAINT kai_credit_topup_events_provider_check CHECK(provider IN('alipay','wechat','qixiang'));
ALTER TABLE kai_credit_topup_provider_claims DROP CONSTRAINT kai_credit_topup_provider_claims_provider_check;
ALTER TABLE kai_credit_topup_provider_claims ADD CONSTRAINT kai_credit_topup_provider_claims_provider_check CHECK(provider IN('alipay','wechat','qixiang'));

ALTER TABLE kai_credit_topups DROP CONSTRAINT kai_credit_topups_status_check;
ALTER TABLE kai_credit_topups ADD CONSTRAINT kai_credit_topups_status_check CHECK(status IN(
  'created','pending','verifying','succeeded','failed','expired','cancelled','manual_review'));
ALTER TABLE kai_credit_topups DROP CONSTRAINT kai_credit_topups_check;
ALTER TABLE kai_credit_topups DROP CONSTRAINT kai_credit_topups_check1;
ALTER TABLE kai_credit_topups ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK(version>0);
ALTER TABLE kai_credit_topups ADD COLUMN payment_rail text;
ALTER TABLE kai_credit_topups ADD COLUMN card_hour_cents bigint;
ALTER TABLE kai_credit_topups ADD COLUMN conversion_numerator integer;
ALTER TABLE kai_credit_topups ADD COLUMN conversion_denominator integer;
ALTER TABLE kai_credit_topups ADD COLUMN entitlement_expires_at timestamptz;
ALTER TABLE kai_credit_topups ADD COLUMN checkout_cipher_version smallint;
ALTER TABLE kai_credit_topups ADD COLUMN checkout_key_id text;
ALTER TABLE kai_credit_topups ADD COLUMN checkout_nonce bytea;
ALTER TABLE kai_credit_topups ADD COLUMN checkout_ciphertext bytea;
ALTER TABLE kai_credit_topups ADD COLUMN checkout_auth_tag bytea;
ALTER TABLE kai_credit_topups ADD COLUMN success_confirmation_source text;
ALTER TABLE kai_credit_topups ADD COLUMN unpaid_query_confirmations integer NOT NULL DEFAULT 0 CHECK(unpaid_query_confirmations>=0);
ALTER TABLE kai_credit_topups ADD COLUMN first_unpaid_query_at timestamptz;
ALTER TABLE kai_credit_topups ADD COLUMN last_unpaid_query_at timestamptz;
ALTER TABLE kai_credit_topups ADD CONSTRAINT kai_credit_topups_direct_checkout_check CHECK(
  provider='qixiang' OR status<>'pending' OR checkout_payload IS NOT NULL);
ALTER TABLE kai_credit_topups ADD CONSTRAINT kai_credit_topups_qixiang_contract_check CHECK(provider<>'qixiang' OR(
  payment_rail='qixiang_alipay' AND amount_cents BETWEEN 100 AND 4999999
  AND card_hour_cents=(amount_cents*1000/1002) AND card_hour_cents>0
  AND credit_micros=card_hour_cents*10000 AND conversion_numerator=1000 AND conversion_denominator=1002
  AND checkout_payload IS NULL AND provider_reference~'^[A-Z0-9]{20,48}$' AND status<>'cancelled'));
ALTER TABLE kai_credit_topups ADD CONSTRAINT kai_credit_topups_verifying_provider_check
  CHECK(status<>'verifying' OR provider='qixiang');
ALTER TABLE kai_credit_topups ADD CONSTRAINT kai_credit_topups_direct_extension_null_check CHECK(provider='qixiang' OR(
  payment_rail IS NULL AND card_hour_cents IS NULL AND conversion_numerator IS NULL AND conversion_denominator IS NULL
  AND entitlement_expires_at IS NULL AND checkout_cipher_version IS NULL AND checkout_key_id IS NULL
  AND checkout_nonce IS NULL AND checkout_ciphertext IS NULL AND checkout_auth_tag IS NULL
  AND success_confirmation_source IS NULL AND unpaid_query_confirmations=0
  AND first_unpaid_query_at IS NULL AND last_unpaid_query_at IS NULL));
ALTER TABLE kai_credit_topups ADD CONSTRAINT kai_credit_topups_qixiang_cipher_tuple_check CHECK(
  (checkout_cipher_version IS NULL AND checkout_key_id IS NULL AND checkout_nonce IS NULL
    AND checkout_ciphertext IS NULL AND checkout_auth_tag IS NULL)
  OR(checkout_cipher_version=1 AND checkout_key_id~'^[a-z0-9][a-z0-9._-]{7,63}$'
    AND octet_length(checkout_nonce)=12 AND octet_length(checkout_ciphertext) BETWEEN 16 AND 8192
    AND octet_length(checkout_auth_tag)=16));
ALTER TABLE kai_credit_topups ADD CONSTRAINT kai_credit_topups_qixiang_success_check CHECK(
  (provider='qixiang' AND status='succeeded' AND succeeded_at IS NOT NULL
    AND entitlement_expires_at=succeeded_at+interval '364 days'
    AND success_confirmation_source IN('callback','query'))
  OR(provider='qixiang' AND status<>'succeeded' AND succeeded_at IS NULL
    AND entitlement_expires_at IS NULL AND success_confirmation_source IS NULL)
  OR(provider<>'qixiang' AND((status='succeeded')=(succeeded_at IS NOT NULL))));
ALTER TABLE kai_credit_topups ADD CONSTRAINT kai_credit_topups_qixiang_trade_identity_check CHECK(
  provider<>'qixiang' OR provider_payment_id IS NULL OR provider_transaction_id IS NULL
  OR provider_payment_id=provider_transaction_id);
ALTER TABLE kai_credit_topups ADD CONSTRAINT kai_credit_topups_qixiang_unpaid_times_check CHECK(
  (unpaid_query_confirmations=0 AND first_unpaid_query_at IS NULL AND last_unpaid_query_at IS NULL)
  OR(unpaid_query_confirmations>0 AND first_unpaid_query_at IS NOT NULL AND last_unpaid_query_at>=first_unpaid_query_at));
ALTER TABLE kai_credit_topups ADD CONSTRAINT kai_credit_topups_qixiang_pending_checkout_check CHECK(
  provider<>'qixiang' OR(
    (status<>'pending' OR(provider_payment_id IS NOT NULL AND checkout_cipher_version=1
      AND checkout_key_id IS NOT NULL AND checkout_nonce IS NOT NULL
      AND checkout_ciphertext IS NOT NULL AND checkout_auth_tag IS NOT NULL))
    AND(status NOT IN('created','failed') OR(provider_payment_id IS NULL AND checkout_cipher_version IS NULL))
    AND(status NOT IN('verifying','expired','manual_review') OR(
      (provider_payment_id IS NULL AND checkout_cipher_version IS NULL)
      OR(provider_payment_id IS NOT NULL AND checkout_cipher_version=1)))
    AND(status<>'succeeded' OR provider_payment_id IS NOT NULL)));
CREATE UNIQUE INDEX kai_credit_topups_qixiang_provider_payment_unique
  ON kai_credit_topups(provider,provider_payment_id) WHERE provider='qixiang' AND provider_payment_id IS NOT NULL;
CREATE INDEX kai_credit_topups_qixiang_reconcile ON kai_credit_topups(next_reconcile_at,created_at,id)
  WHERE provider='qixiang' AND status IN('created','pending','verifying','expired')
    AND reconciliation_dead_lettered_at IS NULL;

CREATE FUNCTION protect_qixiang_topup_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.provider='qixiang' AND(NEW.status<>'created' OR NEW.provider_payment_id IS NOT NULL
    OR NEW.provider_transaction_id IS NOT NULL OR NEW.checkout_cipher_version IS NOT NULL
    OR NEW.checkout_key_id IS NOT NULL OR NEW.checkout_nonce IS NOT NULL OR NEW.checkout_ciphertext IS NOT NULL
    OR NEW.checkout_auth_tag IS NOT NULL OR NEW.unpaid_query_confirmations<>0
    OR NEW.first_unpaid_query_at IS NOT NULL OR NEW.last_unpaid_query_at IS NOT NULL)THEN
    RAISE EXCEPTION 'qixiang topups must begin in created state';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER kai_credit_topups_qixiang_insert_guard BEFORE INSERT ON kai_credit_topups
  FOR EACH ROW EXECUTE FUNCTION protect_qixiang_topup_insert();

CREATE FUNCTION protect_qixiang_topup() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.provider='qixiang' OR NEW.provider='qixiang' THEN
    IF NEW.id<>OLD.id OR NEW.subject_id<>OLD.subject_id OR NEW.created_by_user_id<>OLD.created_by_user_id
      OR NEW.client_request_id<>OLD.client_request_id OR NEW.payload_digest<>OLD.payload_digest OR NEW.provider<>OLD.provider
      OR NEW.payment_rail IS DISTINCT FROM OLD.payment_rail OR NEW.provider_reference<>OLD.provider_reference
      OR NEW.amount_cents<>OLD.amount_cents OR NEW.currency<>OLD.currency OR NEW.credit_micros<>OLD.credit_micros
      OR NEW.card_hour_cents IS DISTINCT FROM OLD.card_hour_cents
      OR NEW.conversion_numerator IS DISTINCT FROM OLD.conversion_numerator
      OR NEW.conversion_denominator IS DISTINCT FROM OLD.conversion_denominator
      OR NEW.conversion_cny_micros_per_credit<>OLD.conversion_cny_micros_per_credit
      OR NEW.expires_at<>OLD.expires_at OR NEW.created_at<>OLD.created_at THEN
      RAISE EXCEPTION 'qixiang topup identity is immutable'; END IF;
    IF OLD.status='verifying' AND NEW.status='pending' THEN
      IF OLD.provider_payment_id IS NULL THEN
        IF OLD.checkout_cipher_version IS NOT NULL OR NEW.provider_payment_id IS NULL
          OR NEW.checkout_cipher_version<>1 OR NEW.checkout_key_id IS NULL OR NEW.checkout_nonce IS NULL
          OR NEW.checkout_ciphertext IS NULL OR NEW.checkout_auth_tag IS NULL THEN
          RAISE EXCEPTION 'qixiang checkout snapshot must be set exactly once';END IF;
      ELSIF NEW.provider_payment_id IS DISTINCT FROM OLD.provider_payment_id
        OR NEW.checkout_cipher_version IS DISTINCT FROM OLD.checkout_cipher_version
        OR NEW.checkout_key_id IS DISTINCT FROM OLD.checkout_key_id
        OR NEW.checkout_nonce IS DISTINCT FROM OLD.checkout_nonce
        OR NEW.checkout_ciphertext IS DISTINCT FROM OLD.checkout_ciphertext
        OR NEW.checkout_auth_tag IS DISTINCT FROM OLD.checkout_auth_tag THEN
        RAISE EXCEPTION 'qixiang checkout snapshot is immutable';END IF;
    ELSIF OLD.status='verifying' AND NEW.status='succeeded'
      AND OLD.provider_payment_id IS NULL AND NEW.provider_payment_id IS NOT NULL
      AND NEW.checkout_cipher_version IS NULL THEN
      -- A create response may be lost while the provider has already accepted
      -- the order. The authoritative paid query is allowed to establish only
      -- the trade id; it must never manufacture a checkout URL.
    ELSIF NEW.provider_payment_id IS DISTINCT FROM OLD.provider_payment_id
      OR NEW.checkout_cipher_version IS DISTINCT FROM OLD.checkout_cipher_version
      OR NEW.checkout_key_id IS DISTINCT FROM OLD.checkout_key_id
      OR NEW.checkout_nonce IS DISTINCT FROM OLD.checkout_nonce
      OR NEW.checkout_ciphertext IS DISTINCT FROM OLD.checkout_ciphertext
      OR NEW.checkout_auth_tag IS DISTINCT FROM OLD.checkout_auth_tag THEN
      RAISE EXCEPTION 'qixiang checkout snapshot is immutable';
    END IF;
    IF OLD.status='verifying' AND NEW.status='succeeded' THEN
      IF OLD.provider_transaction_id IS NOT NULL OR NEW.provider_transaction_id IS NULL
        OR NEW.provider_transaction_id IS DISTINCT FROM NEW.provider_payment_id OR OLD.success_receipt_id IS NOT NULL
        OR NEW.success_receipt_id IS NULL THEN
        RAISE EXCEPTION 'qixiang confirmed trade must be set exactly once';END IF;
    ELSIF NEW.provider_transaction_id IS DISTINCT FROM OLD.provider_transaction_id
      OR NEW.success_receipt_id IS DISTINCT FROM OLD.success_receipt_id THEN
      RAISE EXCEPTION 'qixiang confirmed trade is immutable';
    END IF;
    IF NOT((OLD.status='created' AND NEW.status='verifying')
      OR(OLD.status='verifying' AND NEW.status='created' AND OLD.provider_payment_id IS NULL
        AND NEW.provider_payment_id IS NULL AND NEW.last_reconciliation_error='GATE_CLOSED')
      OR(OLD.status='pending' AND NEW.status IN('verifying','manual_review'))
      OR(OLD.status='verifying' AND NEW.status IN('verifying','pending','failed','succeeded','expired','manual_review'))
      OR(OLD.status='expired' AND NEW.status='verifying')
      OR(OLD.status='manual_review' AND NEW.status='verifying')
      OR(OLD.status='succeeded' AND NEW.status='succeeded' AND OLD.reversed_amount_cents=0
        AND OLD.reversed_credit_micros=0 AND NEW.reversed_amount_cents=NEW.amount_cents
        AND NEW.reversed_credit_micros=NEW.credit_micros)) THEN
      RAISE EXCEPTION 'invalid qixiang topup transition'; END IF;
    NEW.version=OLD.version+1;
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER kai_credit_topups_qixiang_guard BEFORE UPDATE ON kai_credit_topups
  FOR EACH ROW EXECUTE FUNCTION protect_qixiang_topup();
CREATE FUNCTION reject_qixiang_topup_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF OLD.provider='qixiang' THEN RAISE EXCEPTION 'qixiang topups cannot be deleted';END IF;RETURN OLD;END; $$;
CREATE TRIGGER kai_credit_topups_qixiang_no_delete BEFORE DELETE ON kai_credit_topups
  FOR EACH ROW EXECUTE FUNCTION reject_qixiang_topup_delete();

CREATE TABLE qixiang_payment_receipts(
  id uuid PRIMARY KEY,topup_id uuid REFERENCES kai_credit_topups(id),source text NOT NULL CHECK(source IN('callback','query')),
  receipt_key text NOT NULL,provider_reference text NOT NULL,trade_no text,api_trade_no text,
  provider_code integer,provider_status integer CHECK(provider_status IS NULL OR provider_status IN(0,1)),
  trade_status text,payment_type text CHECK(payment_type IN('alipay','wxpay')),
  amount_cents bigint CHECK(amount_cents IS NULL OR amount_cents>0),signature_verified boolean NOT NULL,
  snapshot_matched boolean NOT NULL,payload_digest text NOT NULL,
  processing_result text NOT NULL CHECK(processing_result IN(
    'accepted','duplicate','unknown_reference','provider_rejected','snapshot_mismatch','trade_conflict','manual_review')),
  received_at timestamptz NOT NULL DEFAULT now(),UNIQUE(source,receipt_key),
  CHECK(char_length(receipt_key) BETWEEN 16 AND 160),CHECK(char_length(provider_reference) BETWEEN 1 AND 160),
  CHECK(trade_no IS NULL OR char_length(trade_no) BETWEEN 1 AND 80),
  CHECK(api_trade_no IS NULL OR char_length(api_trade_no) BETWEEN 1 AND 160),
  CHECK(char_length(payload_digest) BETWEEN 16 AND 160));
CREATE FUNCTION validate_qixiang_payment_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE topup_provider text;topup_status text;topup_reference text;topup_payment_id text;topup_amount bigint;
BEGIN
  IF NEW.provider_reference!~'^[A-Z0-9]{20,48}$' THEN RAISE EXCEPTION 'QIXIANG_RECEIPT_REFERENCE_INVALID';END IF;
  IF NEW.processing_result='accepted' THEN
    IF NEW.topup_id IS NULL THEN RAISE EXCEPTION 'QIXIANG_RECEIPT_ACCEPTED_TOPUP_REQUIRED';END IF;
    IF NOT NEW.snapshot_matched OR NEW.payment_type<>'alipay' OR NEW.amount_cents IS NULL THEN
      RAISE EXCEPTION 'QIXIANG_RECEIPT_ACCEPTED_SNAPSHOT_INVALID';END IF;
    IF NEW.payload_digest!~'^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'QIXIANG_RECEIPT_DIGEST_INVALID';END IF;
    IF NEW.source='callback' AND(NOT NEW.signature_verified OR NEW.trade_status<>'TRADE_SUCCESS'
      OR NEW.trade_no IS NULL OR NEW.provider_code IS NOT NULL OR NEW.provider_status IS NOT NULL
      OR NEW.api_trade_no IS NOT NULL OR NEW.receipt_key!~'^callback:[0-9a-f]{64}$')THEN
      RAISE EXCEPTION 'QIXIANG_CALLBACK_RECEIPT_INVALID';END IF;
    IF NEW.source='query' AND(NEW.signature_verified OR NEW.provider_code IS DISTINCT FROM 1
      OR NEW.provider_status IS NULL OR NEW.provider_status NOT IN(0,1)
      OR NEW.trade_status IS NOT NULL OR(NEW.provider_status=1 AND(NEW.trade_no IS NULL OR NEW.api_trade_no IS NULL)))THEN
      RAISE EXCEPTION 'QIXIANG_QUERY_RECEIPT_INVALID';END IF;
    IF NEW.source='query' AND NEW.receipt_key!~'^query:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'QIXIANG_QUERY_RECEIPT_KEY_INVALID';END IF;
  END IF;
  IF NEW.topup_id IS NOT NULL THEN
    SELECT provider,status,provider_reference,provider_payment_id,amount_cents
      INTO topup_provider,topup_status,topup_reference,topup_payment_id,topup_amount
      FROM kai_credit_topups WHERE id=NEW.topup_id;
    IF topup_provider IS DISTINCT FROM 'qixiang' OR topup_reference IS DISTINCT FROM NEW.provider_reference
      OR(NEW.snapshot_matched AND(topup_amount IS DISTINCT FROM NEW.amount_cents
        OR NEW.payment_type IS DISTINCT FROM 'alipay'))
      OR(NEW.processing_result='accepted' AND NEW.trade_no IS NOT NULL
        AND topup_payment_id IS DISTINCT FROM NEW.trade_no
        AND NOT(topup_payment_id IS NULL AND topup_status='verifying'))THEN
      RAISE EXCEPTION 'QIXIANG_RECEIPT_TOPUP_MISMATCH';END IF;
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER qixiang_payment_receipts_validate BEFORE INSERT ON qixiang_payment_receipts
  FOR EACH ROW EXECUTE FUNCTION validate_qixiang_payment_receipt();
ALTER TABLE kai_credit_topups ADD COLUMN success_receipt_id uuid UNIQUE REFERENCES qixiang_payment_receipts(id);
ALTER TABLE kai_credit_topups ADD CONSTRAINT kai_credit_topups_qixiang_success_receipt_check CHECK(
  (provider='qixiang' AND((status='succeeded')=(success_receipt_id IS NOT NULL)))
  OR(provider<>'qixiang' AND success_receipt_id IS NULL));
CREATE INDEX qixiang_payment_receipts_topup_time ON qixiang_payment_receipts(topup_id,received_at,id)
  WHERE topup_id IS NOT NULL;
CREATE TRIGGER qixiang_payment_receipts_immutable BEFORE UPDATE OR DELETE ON qixiang_payment_receipts
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();

ALTER TABLE kai_credit_accounts DROP CONSTRAINT kai_credit_accounts_account_kind_check;
ALTER TABLE kai_credit_accounts ADD CONSTRAINT kai_credit_accounts_account_kind_check CHECK(account_kind IN(
  'available','reserved','refund_hold','supplier_receivable','supplier_earnings_available','payout_frozen',
  'platform_issuance','platform_clearing','platform_revenue'));
ALTER TABLE kai_credit_accounts DROP CONSTRAINT kai_credit_accounts_kind_owner_check;
ALTER TABLE kai_credit_accounts ADD CONSTRAINT kai_credit_accounts_kind_owner_check CHECK(
  (owner_kind='subject' AND account_kind IN(
    'available','reserved','refund_hold','supplier_receivable','supplier_earnings_available','payout_frozen') AND allow_negative=false)
  OR(owner_kind='platform' AND account_kind IN('platform_issuance','platform_clearing','platform_revenue')));

CREATE TABLE kai_credit_lots(
  id uuid PRIMARY KEY,subject_id uuid NOT NULL REFERENCES trading_subjects(id),source_kind text NOT NULL CHECK(source_kind='qixiang_topup'),
  source_topup_id uuid NOT NULL UNIQUE REFERENCES kai_credit_topups(id),grant_transaction_id uuid NOT NULL UNIQUE REFERENCES kai_credit_transactions(id),
  granted_micros bigint NOT NULL,available_micros bigint NOT NULL,reserved_micros bigint NOT NULL,
  refund_pending_micros bigint NOT NULL,consumed_micros bigint NOT NULL,expired_micros bigint NOT NULL,refunded_micros bigint NOT NULL,
  expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(granted_micros>0 AND granted_micros%10000=0),
  CHECK(available_micros>=0 AND available_micros%10000=0),CHECK(reserved_micros>=0 AND reserved_micros%10000=0),
  CHECK(refund_pending_micros>=0 AND refund_pending_micros%10000=0),CHECK(consumed_micros>=0 AND consumed_micros%10000=0),
  CHECK(expired_micros>=0 AND expired_micros%10000=0),CHECK(refunded_micros>=0 AND refunded_micros%10000=0),
  CHECK(available_micros+reserved_micros+refund_pending_micros+consumed_micros+expired_micros+refunded_micros=granted_micros));
CREATE INDEX kai_credit_lots_fefo ON kai_credit_lots(subject_id,expires_at,id) WHERE available_micros>0;
CREATE INDEX kai_credit_lots_expiry ON kai_credit_lots(expires_at,id) WHERE available_micros>0;
CREATE TABLE kai_credit_lot_allocations(
  id uuid PRIMARY KEY,lot_id uuid NOT NULL REFERENCES kai_credit_lots(id),reference_type text NOT NULL CHECK(reference_type IN('credit_order','vast_order')),
  reference_id uuid NOT NULL,allocation_key text NOT NULL,allocated_micros bigint NOT NULL,reserved_micros bigint NOT NULL,
  consumed_micros bigint NOT NULL,released_micros bigint NOT NULL,restored_micros bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(allocated_micros>0 AND allocated_micros%10000=0),CHECK(reserved_micros>=0 AND reserved_micros%10000=0),
  CHECK(consumed_micros>=0 AND consumed_micros%10000=0),CHECK(released_micros>=0 AND released_micros%10000=0),
  CHECK(restored_micros>=0 AND restored_micros%10000=0),
  CHECK(reserved_micros+consumed_micros+released_micros+restored_micros=allocated_micros),
  UNIQUE(lot_id,reference_type,reference_id),UNIQUE(allocation_key,lot_id));
CREATE INDEX kai_credit_lot_allocations_reference ON kai_credit_lot_allocations(reference_type,reference_id);
CREATE TABLE kai_credit_lot_movements(
  id uuid PRIMARY KEY,lot_id uuid NOT NULL REFERENCES kai_credit_lots(id),allocation_id uuid REFERENCES kai_credit_lot_allocations(id),
  ledger_transaction_id uuid NOT NULL REFERENCES kai_credit_transactions(id),kind text NOT NULL CHECK(kind IN(
    'grant','reserve','consume','release_available','release_expired','restore_available','restore_expired',
    'refund_hold','refund_release_available','refund_release_expired','refund_confirm','expire')),
  amount_micros bigint NOT NULL CHECK(amount_micros>0 AND amount_micros%10000=0),from_bucket text,to_bucket text,
  idempotency_owner text NOT NULL,scope text NOT NULL,idempotency_key text NOT NULL,payload_digest text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(idempotency_owner,scope,idempotency_key,lot_id,kind),
  CHECK((kind='grant' AND from_bucket IS NULL AND to_bucket='available')
    OR(kind='reserve' AND from_bucket='available' AND to_bucket='reserved')
    OR(kind='consume' AND from_bucket='reserved' AND to_bucket='consumed')
    OR(kind='release_available' AND from_bucket='reserved' AND to_bucket='available')
    OR(kind='release_expired' AND from_bucket='reserved' AND to_bucket='expired')
    OR(kind='restore_available' AND from_bucket='consumed' AND to_bucket='available')
    OR(kind='restore_expired' AND from_bucket='consumed' AND to_bucket='expired')
    OR(kind='refund_hold' AND from_bucket='available' AND to_bucket='refund_pending')
    OR(kind='refund_release_available' AND from_bucket='refund_pending' AND to_bucket='available')
    OR(kind='refund_release_expired' AND from_bucket='refund_pending' AND to_bucket='expired')
    OR(kind='refund_confirm' AND from_bucket='refund_pending' AND to_bucket='refunded')
    OR(kind='expire' AND from_bucket='available' AND to_bucket='expired')),
  CHECK((kind IN('reserve','consume','release_available','release_expired','restore_available','restore_expired')
      AND allocation_id IS NOT NULL)
    OR(kind IN('grant','refund_hold','refund_release_available','refund_release_expired','refund_confirm','expire')
      AND allocation_id IS NULL)));
CREATE INDEX kai_credit_lot_movements_lot_time ON kai_credit_lot_movements(lot_id,occurred_at,id);
CREATE FUNCTION protect_kai_credit_lot_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id<>OLD.id OR NEW.subject_id<>OLD.subject_id OR NEW.source_kind<>OLD.source_kind
    OR NEW.source_topup_id<>OLD.source_topup_id OR NEW.grant_transaction_id<>OLD.grant_transaction_id
    OR NEW.granted_micros<>OLD.granted_micros OR NEW.expires_at<>OLD.expires_at OR NEW.created_at<>OLD.created_at THEN
    RAISE EXCEPTION 'kai credit lot identity is immutable';END IF;NEW.updated_at=now();RETURN NEW;END; $$;
CREATE TRIGGER kai_credit_lots_guard BEFORE UPDATE ON kai_credit_lots FOR EACH ROW EXECUTE FUNCTION protect_kai_credit_lot_identity();
CREATE TRIGGER kai_credit_lots_no_delete BEFORE DELETE ON kai_credit_lots FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE FUNCTION protect_kai_credit_lot_allocation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id<>OLD.id OR NEW.lot_id<>OLD.lot_id OR NEW.reference_type<>OLD.reference_type OR NEW.reference_id<>OLD.reference_id
    OR NEW.allocation_key<>OLD.allocation_key OR NEW.allocated_micros<>OLD.allocated_micros OR NEW.created_at<>OLD.created_at THEN
    RAISE EXCEPTION 'kai credit lot allocation identity is immutable';END IF;NEW.updated_at=now();RETURN NEW;END; $$;
CREATE TRIGGER kai_credit_lot_allocations_guard BEFORE UPDATE ON kai_credit_lot_allocations
  FOR EACH ROW EXECUTE FUNCTION protect_kai_credit_lot_allocation();
CREATE TRIGGER kai_credit_lot_allocations_no_delete BEFORE DELETE ON kai_credit_lot_allocations
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER kai_credit_lot_movements_immutable BEFORE UPDATE OR DELETE ON kai_credit_lot_movements
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();

CREATE FUNCTION enforce_kai_credit_lot_ledger_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE touched_lot uuid; touched_transaction uuid; lot_subject uuid; allocation_lot uuid; invalid_subject uuid;
DECLARE grant_total bigint; reserve_total bigint; consume_total bigint; release_available_total bigint;
DECLARE release_expired_total bigint; restore_available_total bigint; restore_expired_total bigint;
DECLARE refund_hold_total bigint; refund_release_available_total bigint; refund_release_expired_total bigint;
DECLARE refund_confirm_total bigint; expire_total bigint;
DECLARE ledger_available bigint; ledger_reserved bigint; ledger_hold bigint; ledger_issuance bigint; ledger_sum bigint;
DECLARE bad_allocation uuid; lot_row kai_credit_lots%ROWTYPE;
DECLARE topup_subject uuid;topup_provider text;topup_status text;topup_credit bigint;topup_expiry timestamptz;
DECLARE movement_subjects integer;movement_subject uuid;movement_count integer;
BEGIN
  IF TG_TABLE_NAME='kai_credit_lot_movements' THEN
    touched_lot=NEW.lot_id;touched_transaction=NEW.ledger_transaction_id;
    SELECT subject_id INTO lot_subject FROM kai_credit_lots WHERE id=touched_lot;
    IF NEW.allocation_id IS NOT NULL THEN
      SELECT lot_id INTO allocation_lot FROM kai_credit_lot_allocations WHERE id=NEW.allocation_id;
      IF allocation_lot IS DISTINCT FROM touched_lot THEN RAISE EXCEPTION 'QIXIANG_LOT_ALLOCATION_MISMATCH';END IF;
    END IF;
  ELSIF TG_TABLE_NAME='kai_credit_lots' THEN touched_lot=NEW.id;
  ELSIF TG_TABLE_NAME='kai_credit_lot_allocations' THEN touched_lot=NEW.lot_id;
  ELSE touched_transaction=NEW.id;END IF;

  IF touched_lot IS NOT NULL THEN
    SELECT * INTO lot_row FROM kai_credit_lots WHERE id=touched_lot;
    SELECT subject_id,provider,status,credit_micros,entitlement_expires_at
      INTO topup_subject,topup_provider,topup_status,topup_credit,topup_expiry
      FROM kai_credit_topups WHERE id=lot_row.source_topup_id;
    IF topup_provider IS DISTINCT FROM 'qixiang' OR topup_status IS DISTINCT FROM 'succeeded'
      OR topup_subject IS DISTINCT FROM lot_row.subject_id OR topup_credit IS DISTINCT FROM lot_row.granted_micros
      OR topup_expiry IS DISTINCT FROM lot_row.expires_at THEN
      RAISE EXCEPTION 'QIXIANG_LOT_TOPUP_MISMATCH';END IF;
    SELECT COALESCE(sum(amount_micros)FILTER(WHERE kind='grant'),0),
      COALESCE(sum(amount_micros)FILTER(WHERE kind='reserve'),0),COALESCE(sum(amount_micros)FILTER(WHERE kind='consume'),0),
      COALESCE(sum(amount_micros)FILTER(WHERE kind='release_available'),0),
      COALESCE(sum(amount_micros)FILTER(WHERE kind='release_expired'),0),
      COALESCE(sum(amount_micros)FILTER(WHERE kind='restore_available'),0),
      COALESCE(sum(amount_micros)FILTER(WHERE kind='restore_expired'),0),
      COALESCE(sum(amount_micros)FILTER(WHERE kind='refund_hold'),0),
      COALESCE(sum(amount_micros)FILTER(WHERE kind='refund_release_available'),0),
      COALESCE(sum(amount_micros)FILTER(WHERE kind='refund_release_expired'),0),
      COALESCE(sum(amount_micros)FILTER(WHERE kind='refund_confirm'),0),
      COALESCE(sum(amount_micros)FILTER(WHERE kind='expire'),0)
    INTO grant_total,reserve_total,consume_total,release_available_total,release_expired_total,
      restore_available_total,restore_expired_total,refund_hold_total,refund_release_available_total,
      refund_release_expired_total,refund_confirm_total,expire_total
    FROM kai_credit_lot_movements WHERE lot_id=touched_lot;
    IF lot_row.granted_micros<>grant_total
      OR lot_row.available_micros<>grant_total+release_available_total+restore_available_total
        +refund_release_available_total-reserve_total-refund_hold_total-expire_total
      OR lot_row.reserved_micros<>reserve_total-consume_total-release_available_total-release_expired_total
      OR lot_row.refund_pending_micros<>refund_hold_total-refund_release_available_total
        -refund_release_expired_total-refund_confirm_total
      OR lot_row.consumed_micros<>consume_total-restore_available_total-restore_expired_total
      OR lot_row.expired_micros<>expire_total+release_expired_total+restore_expired_total+refund_release_expired_total
      OR lot_row.refunded_micros<>refund_confirm_total THEN
      RAISE EXCEPTION 'QIXIANG_LOT_MOVEMENT_IMBALANCE';END IF;
    SELECT a.id INTO bad_allocation FROM kai_credit_lot_allocations a WHERE a.lot_id=touched_lot AND(
      a.allocated_micros<>(SELECT COALESCE(sum(m.amount_micros),0)FROM kai_credit_lot_movements m
        WHERE m.allocation_id=a.id AND m.kind='reserve')
      OR a.reserved_micros<>(SELECT COALESCE(sum(m.amount_micros)FILTER(WHERE m.kind='reserve'),0)
        -COALESCE(sum(m.amount_micros)FILTER(WHERE m.kind IN('consume','release_available','release_expired')),0)
        FROM kai_credit_lot_movements m WHERE m.allocation_id=a.id)
      OR a.consumed_micros<>(SELECT COALESCE(sum(m.amount_micros)FILTER(WHERE m.kind='consume'),0)
        -COALESCE(sum(m.amount_micros)FILTER(WHERE m.kind IN('restore_available','restore_expired')),0)
        FROM kai_credit_lot_movements m WHERE m.allocation_id=a.id)
      OR a.released_micros<>(SELECT COALESCE(sum(m.amount_micros)FILTER(WHERE m.kind IN('release_available','release_expired')),0)
        FROM kai_credit_lot_movements m WHERE m.allocation_id=a.id)
      OR a.restored_micros<>(SELECT COALESCE(sum(m.amount_micros)FILTER(WHERE m.kind IN('restore_available','restore_expired')),0)
        FROM kai_credit_lot_movements m WHERE m.allocation_id=a.id))LIMIT 1;
    IF bad_allocation IS NOT NULL THEN RAISE EXCEPTION 'QIXIANG_LOT_ALLOCATION_IMBALANCE';END IF;
  END IF;

  IF touched_transaction IS NOT NULL THEN
    SELECT count(DISTINCT l.subject_id),(array_agg(l.subject_id))[1],count(*)
      INTO movement_subjects,movement_subject,movement_count
      FROM kai_credit_lot_movements m JOIN kai_credit_lots l ON l.id=m.lot_id
      WHERE m.ledger_transaction_id=touched_transaction;
    IF movement_count=0 THEN RETURN NULL;END IF;
    lot_subject=movement_subject;
    IF movement_subjects<>1 THEN RAISE EXCEPTION 'QIXIANG_LOT_LEDGER_MULTIPLE_SUBJECTS';END IF;
    IF NOT EXISTS(SELECT 1 FROM kai_credit_transactions WHERE id=touched_transaction AND status='posted') THEN
      RAISE EXCEPTION 'QIXIANG_LOT_LEDGER_TRANSACTION_NOT_POSTED';END IF;
    SELECT COALESCE(sum(e.amount_micros),0),
      COALESCE(sum(e.amount_micros)FILTER(WHERE a.subject_id=lot_subject AND a.account_kind='available'),0),
      COALESCE(sum(e.amount_micros)FILTER(WHERE a.subject_id=lot_subject AND a.account_kind='reserved'),0),
      COALESCE(sum(e.amount_micros)FILTER(WHERE a.subject_id=lot_subject AND a.account_kind='refund_hold'),0),
      COALESCE(sum(e.amount_micros)FILTER(WHERE a.owner_kind='platform' AND a.account_kind='platform_issuance'),0)
    INTO ledger_sum,ledger_available,ledger_reserved,ledger_hold,ledger_issuance
    FROM kai_credit_entries e JOIN kai_credit_accounts a ON a.id=e.account_id WHERE e.transaction_id=touched_transaction;
    IF ledger_sum<>0 THEN RAISE EXCEPTION 'QIXIANG_LOT_LEDGER_UNBALANCED';END IF;
    SELECT COALESCE(sum(amount_micros)FILTER(WHERE kind='grant'),0),
      COALESCE(sum(amount_micros)FILTER(WHERE kind='reserve'),0),COALESCE(sum(amount_micros)FILTER(WHERE kind='consume'),0),
      COALESCE(sum(amount_micros)FILTER(WHERE kind='release_available'),0),
      COALESCE(sum(amount_micros)FILTER(WHERE kind='release_expired'),0),
      COALESCE(sum(amount_micros)FILTER(WHERE kind='restore_available'),0),
      COALESCE(sum(amount_micros)FILTER(WHERE kind='restore_expired'),0),
      COALESCE(sum(amount_micros)FILTER(WHERE kind='refund_hold'),0),
      COALESCE(sum(amount_micros)FILTER(WHERE kind='refund_release_available'),0),
      COALESCE(sum(amount_micros)FILTER(WHERE kind='refund_release_expired'),0),
      COALESCE(sum(amount_micros)FILTER(WHERE kind='refund_confirm'),0),COALESCE(sum(amount_micros)FILTER(WHERE kind='expire'),0)
    INTO grant_total,reserve_total,consume_total,release_available_total,release_expired_total,
      restore_available_total,restore_expired_total,refund_hold_total,refund_release_available_total,
      refund_release_expired_total,refund_confirm_total,expire_total
    FROM kai_credit_lot_movements WHERE ledger_transaction_id=touched_transaction;
    IF lot_subject IS NOT NULL THEN
    IF grant_total>0 AND(ledger_available<>grant_total OR ledger_issuance<>-grant_total)THEN RAISE EXCEPTION 'QIXIANG_LOT_LEDGER_DIRECTION';END IF;
    IF refund_hold_total>0 AND(ledger_available<>-refund_hold_total OR ledger_hold<>refund_hold_total)THEN RAISE EXCEPTION 'QIXIANG_LOT_LEDGER_DIRECTION';END IF;
    IF refund_release_available_total>0 AND(ledger_hold<>-refund_release_available_total OR ledger_available<>refund_release_available_total)THEN RAISE EXCEPTION 'QIXIANG_LOT_LEDGER_DIRECTION';END IF;
    IF refund_release_expired_total+refund_confirm_total>0 AND(ledger_hold<>-(refund_release_expired_total+refund_confirm_total)
      OR ledger_issuance<>refund_release_expired_total+refund_confirm_total)THEN RAISE EXCEPTION 'QIXIANG_LOT_LEDGER_DIRECTION';END IF;
    IF expire_total>0 AND(ledger_available<>-expire_total OR ledger_issuance<>expire_total)THEN RAISE EXCEPTION 'QIXIANG_LOT_LEDGER_DIRECTION';END IF;
    IF reserve_total>0 AND(-ledger_available<reserve_total OR ledger_reserved<reserve_total)THEN RAISE EXCEPTION 'QIXIANG_LOT_LEDGER_DIRECTION';END IF;
    IF consume_total>0 AND -ledger_reserved<consume_total THEN RAISE EXCEPTION 'QIXIANG_LOT_LEDGER_DIRECTION';END IF;
    IF release_available_total>0 AND(-ledger_reserved<release_available_total OR ledger_available<release_available_total)THEN RAISE EXCEPTION 'QIXIANG_LOT_LEDGER_DIRECTION';END IF;
    IF release_expired_total>0 AND(-ledger_reserved<release_expired_total OR ledger_issuance<release_expired_total)THEN RAISE EXCEPTION 'QIXIANG_LOT_LEDGER_DIRECTION';END IF;
    IF restore_available_total>0 AND ledger_available<restore_available_total THEN RAISE EXCEPTION 'QIXIANG_LOT_LEDGER_DIRECTION';END IF;
    IF restore_expired_total>0 AND ledger_issuance<restore_expired_total THEN RAISE EXCEPTION 'QIXIANG_LOT_LEDGER_DIRECTION';END IF;
    END IF;
  END IF;

  WITH lot_totals AS(SELECT subject_id,sum(available_micros)available,sum(reserved_micros)reserved,
    sum(refund_pending_micros)refund_hold FROM kai_credit_lots GROUP BY subject_id),ledger_totals AS(
    SELECT a.subject_id,COALESCE(sum(e.amount_micros)FILTER(WHERE a.account_kind='available'AND t.status='posted'),0)available,
      COALESCE(sum(e.amount_micros)FILTER(WHERE a.account_kind='reserved'AND t.status='posted'),0)reserved,
      COALESCE(sum(e.amount_micros)FILTER(WHERE a.account_kind='refund_hold'AND t.status='posted'),0)refund_hold
    FROM kai_credit_accounts a LEFT JOIN kai_credit_entries e ON e.account_id=a.id
    LEFT JOIN kai_credit_transactions t ON t.id=e.transaction_id WHERE a.subject_id IS NOT NULL GROUP BY a.subject_id)
  SELECT l.subject_id INTO invalid_subject FROM lot_totals l LEFT JOIN ledger_totals b ON b.subject_id=l.subject_id
  WHERE l.available>COALESCE(b.available,0)OR l.reserved>COALESCE(b.reserved,0)OR l.refund_hold>COALESCE(b.refund_hold,0)LIMIT 1;
  IF invalid_subject IS NOT NULL THEN RAISE EXCEPTION 'QIXIANG_LOT_LEDGER_BUCKET_IMBALANCE';END IF;RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER kai_credit_lots_ledger_guard AFTER INSERT OR UPDATE ON kai_credit_lots
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_kai_credit_lot_ledger_guard();
CREATE CONSTRAINT TRIGGER kai_credit_lot_movements_ledger_guard AFTER INSERT ON kai_credit_lot_movements
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_kai_credit_lot_ledger_guard();
CREATE CONSTRAINT TRIGGER kai_credit_lot_allocations_ledger_guard AFTER INSERT OR UPDATE ON kai_credit_lot_allocations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_kai_credit_lot_ledger_guard();
CREATE CONSTRAINT TRIGGER kai_credit_transactions_lot_guard AFTER INSERT OR UPDATE ON kai_credit_transactions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_kai_credit_lot_ledger_guard();

CREATE FUNCTION qixiang_json_has_exact_keys(value jsonb,expected text[]) RETURNS boolean
  LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_typeof(value)='object' AND COALESCE(
    (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(value) AS key),ARRAY[]::text[])=expected;
$$;
CREATE FUNCTION qixiang_json_strings(value jsonb,keys text[]) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(bool_and(jsonb_typeof(value->key)='string'),false) FROM unnest(keys) AS key;
$$;
CREATE FUNCTION qixiang_iso_utc(value text) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE parsed timestamptz;canonical text;
BEGIN
  IF value IS NULL OR value!~'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$' THEN RETURN false;END IF;
  BEGIN parsed=value::timestamptz;EXCEPTION WHEN OTHERS THEN RETURN false;END;
  canonical=CASE WHEN value~'\.\d{3}Z$'
    THEN to_char(parsed AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    ELSE to_char(parsed AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')END;
  RETURN canonical=value;
END; $$;
CREATE FUNCTION validate_qixiang_evidence_metadata(kind_value text,value jsonb) RETURNS boolean
  LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  CASE kind_value
    WHEN 'merchant_key_rotation' THEN RETURN qixiang_json_has_exact_keys(value,ARRAY[
      'credentialVersion','merchantId','newKeyFingerprint','oldKeyFingerprint','rotatedAt'])
      AND qixiang_json_strings(value,ARRAY['credentialVersion','merchantId','newKeyFingerprint','oldKeyFingerprint','rotatedAt'])
      AND value->>'merchantId'='4611' AND qixiang_iso_utc(value->>'rotatedAt')
      AND char_length(value->>'credentialVersion') BETWEEN 1 AND 80
      AND value->>'newKeyFingerprint'~'^[0-9a-f]{64}$' AND value->>'oldKeyFingerprint'~'^[0-9a-f]{64}$'
      AND value->>'newKeyFingerprint'<>value->>'oldKeyFingerprint';
    WHEN 'old_key_revocation' THEN RETURN qixiang_json_has_exact_keys(value,ARRAY[
      'merchantId','oldKeyFingerprint','providerCaseRef','revokedAt'])
      AND qixiang_json_strings(value,ARRAY['merchantId','oldKeyFingerprint','providerCaseRef','revokedAt'])
      AND value->>'merchantId'='4611' AND qixiang_iso_utc(value->>'revokedAt')
      AND value->>'oldKeyFingerprint'~'^[0-9a-f]{64}$'
      AND char_length(value->>'providerCaseRef') BETWEEN 3 AND 500;
    WHEN 'merchant_entity_match' THEN RETURN qixiang_json_has_exact_keys(value,ARRAY[
      'legalEntityName','merchantId','providerRegisteredName','unifiedSocialCreditCode','verifiedAt'])
      AND qixiang_json_strings(value,ARRAY['legalEntityName','merchantId','providerRegisteredName','unifiedSocialCreditCode','verifiedAt'])
      AND value->>'merchantId'='4611' AND qixiang_iso_utc(value->>'verifiedAt')
      AND char_length(value->>'legalEntityName') BETWEEN 2 AND 200
      AND char_length(value->>'providerRegisteredName') BETWEEN 2 AND 200
      AND value->>'unifiedSocialCreditCode'~'^[0-9A-Z]{18}$';
    WHEN 'domain_app_scene_approval' THEN RETURN qixiang_json_has_exact_keys(value,ARRAY[
      'appPackage','approvedAt','domain','merchantId','providerCaseRef','scene'])
      AND qixiang_json_strings(value,ARRAY['appPackage','approvedAt','domain','merchantId','providerCaseRef','scene'])
      AND value->>'merchantId'='4611' AND value->>'domain'='cloudpay.kai.com'
      AND value->>'appPackage'='com.kaicloud.marketplace' AND value->>'scene'='android_h5_alipay'
      AND qixiang_iso_utc(value->>'approvedAt') AND char_length(value->>'providerCaseRef') BETWEEN 3 AND 500;
    WHEN 'service_category_approval' THEN RETURN qixiang_json_has_exact_keys(value,ARRAY[
      'approvedAt','category','entitlementDays','merchantId','nonCash','nonTransferable'])
      AND qixiang_json_strings(value,ARRAY['approvedAt','category','merchantId'])
      AND jsonb_typeof(value->'entitlementDays')='number' AND jsonb_typeof(value->'nonCash')='boolean'
      AND jsonb_typeof(value->'nonTransferable')='boolean'
      AND value->>'merchantId'='4611' AND value->'entitlementDays'='364'::jsonb
      AND value->'nonTransferable'='true'::jsonb AND value->'nonCash'='true'::jsonb
      AND qixiang_iso_utc(value->>'approvedAt') AND char_length(value->>'category') BETWEEN 1 AND 200;
    WHEN 'refund_api_confirmation' THEN RETURN qixiang_json_has_exact_keys(value,ARRAY[
      'confirmationRequired','enabledAt','merchantId','providerCaseRef','successCodes','supportsOutTradeNo'])
      AND qixiang_json_strings(value,ARRAY['enabledAt','merchantId','providerCaseRef'])
      AND jsonb_typeof(value->'confirmationRequired')='boolean'
      AND jsonb_typeof(value->'supportsOutTradeNo')='boolean' AND jsonb_typeof(value->'successCodes')='array'
      AND value->>'merchantId'='4611' AND value->'supportsOutTradeNo'='true'::jsonb
      AND value->'successCodes'='[0,1]'::jsonb AND value->'confirmationRequired'='true'::jsonb
      AND qixiang_iso_utc(value->>'enabledAt') AND char_length(value->>'providerCaseRef') BETWEEN 3 AND 500;
    WHEN 'real_fulfillment_acceptance' THEN RETURN qixiang_json_has_exact_keys(value,ARRAY[
      'acceptanceReportDigest','fulfillmentType','merchantId','testedAt'])
      AND qixiang_json_strings(value,ARRAY['acceptanceReportDigest','fulfillmentType','merchantId','testedAt'])
      AND value->>'merchantId'='4611' AND value->>'fulfillmentType'='compute_card_hours'
      AND qixiang_iso_utc(value->>'testedAt') AND value->>'acceptanceReportDigest'~'^[0-9a-f]{64}$';
    WHEN 'reconciliation_acceptance' THEN RETURN qixiang_json_has_exact_keys(value,ARRAY[
      'activeQuery','callback','lateSuccess','merchantId','reportDigest','testedAt'])
      AND qixiang_json_strings(value,ARRAY['merchantId','reportDigest','testedAt'])
      AND jsonb_typeof(value->'activeQuery')='boolean' AND jsonb_typeof(value->'callback')='boolean'
      AND jsonb_typeof(value->'lateSuccess')='boolean'
      AND value->>'merchantId'='4611' AND value->'callback'='true'::jsonb
      AND value->'activeQuery'='true'::jsonb AND value->'lateSuccess'='true'::jsonb
      AND qixiang_iso_utc(value->>'testedAt') AND value->>'reportDigest'~'^[0-9a-f]{64}$';
    WHEN 'approved_max_amount' THEN RETURN qixiang_json_has_exact_keys(value,ARRAY[
      'approvedAt','currency','maxCents','merchantId','minCents','providerLimitRef'])
      AND qixiang_json_strings(value,ARRAY['approvedAt','currency','merchantId','providerLimitRef'])
      AND jsonb_typeof(value->'minCents')='number'
      AND value->>'merchantId'='4611' AND value->>'currency'='CNY' AND value->'minCents'='100'::jsonb
      AND jsonb_typeof(value->'maxCents')='number' AND(value->>'maxCents')::bigint BETWEEN 100 AND 4999999
      AND qixiang_iso_utc(value->>'approvedAt') AND char_length(value->>'providerLimitRef') BETWEEN 3 AND 500;
    WHEN 'lot_accounting_acceptance' THEN RETURN qixiang_json_has_exact_keys(value,ARRAY[
      'schemaVersion','stores','testReportDigest','testedAt']) AND value->'schemaVersion'='1'::jsonb
      AND qixiang_json_strings(value,ARRAY['testReportDigest','testedAt'])
      AND jsonb_typeof(value->'schemaVersion')='number' AND jsonb_typeof(value->'stores')='array'
      AND value->'stores'='["credit-orders","credits","device-commerce","fulfillment","topups-reversal","vast-market"]'::jsonb
      AND qixiang_iso_utc(value->>'testedAt') AND value->>'testReportDigest'~'^[0-9a-f]{64}$';
    ELSE RETURN false;
  END CASE;
END; $$;

CREATE FUNCTION qixiang_active_operator(user_id uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS(SELECT 1 FROM users WHERE id=user_id AND status='active' AND role IN('operator','admin'));
$$;

CREATE TABLE qixiang_provider_approval_evidence(
  id uuid PRIMARY KEY,kind text NOT NULL CHECK(kind IN(
    'merchant_key_rotation','old_key_revocation','merchant_entity_match','domain_app_scene_approval',
    'service_category_approval','refund_api_confirmation','real_fulfillment_acceptance',
    'reconciliation_acceptance','approved_max_amount','lot_accounting_acceptance')),
  evidence_ref varchar(500) NOT NULL,evidence_digest char(64) NOT NULL CHECK(
    char_length(evidence_digest)=64 AND evidence_digest~'^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'approved' CHECK(status IN('approved','revoked','expired')),
  metadata jsonb NOT NULL CHECK(jsonb_typeof(metadata)='object'),
  verified_by_operator_id uuid NOT NULL REFERENCES users(id),approved_by_operator_id uuid NOT NULL REFERENCES users(id),
  valid_from timestamptz NOT NULL,valid_until timestamptz,revoked_at timestamptz,revocation_evidence_ref varchar(500),
  revoked_by_operator_id uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(kind,evidence_ref),
  CHECK(validate_qixiang_evidence_metadata(kind,metadata)),
  CHECK(verified_by_operator_id<>approved_by_operator_id),CHECK(valid_until IS NULL OR valid_until>valid_from),
  CHECK((status IN('approved','expired') AND revoked_at IS NULL AND revocation_evidence_ref IS NULL
      AND revoked_by_operator_id IS NULL)
    OR(status='revoked' AND revoked_at IS NOT NULL AND char_length(revocation_evidence_ref) BETWEEN 3 AND 500
      AND revoked_by_operator_id IS NOT NULL)));
CREATE UNIQUE INDEX qixiang_provider_approval_evidence_one_approved_kind
  ON qixiang_provider_approval_evidence(kind) WHERE status='approved';
CREATE FUNCTION protect_qixiang_provider_approval_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'approved' THEN RAISE EXCEPTION 'qixiang approval evidence must begin approved';END IF;
    IF NOT qixiang_active_operator(NEW.verified_by_operator_id)
      OR NOT qixiang_active_operator(NEW.approved_by_operator_id)THEN
      RAISE EXCEPTION 'qixiang approval evidence requires active operator dual control';END IF;
  END IF;
  IF NEW.status='approved' AND(NEW.valid_from>now() OR(NEW.valid_until IS NOT NULL AND NEW.valid_until<=now()))THEN
    RAISE EXCEPTION 'qixiang approval evidence is not currently valid';END IF;
  IF TG_OP='INSERT' THEN RETURN NEW;END IF;
  IF NEW.id<>OLD.id OR NEW.kind<>OLD.kind OR NEW.evidence_ref<>OLD.evidence_ref
    OR NEW.evidence_digest<>OLD.evidence_digest OR NEW.metadata<>OLD.metadata
    OR NEW.verified_by_operator_id<>OLD.verified_by_operator_id OR NEW.approved_by_operator_id<>OLD.approved_by_operator_id
    OR NEW.valid_from<>OLD.valid_from OR NEW.valid_until IS DISTINCT FROM OLD.valid_until OR NEW.created_at<>OLD.created_at THEN
    RAISE EXCEPTION 'qixiang approval evidence identity is immutable';END IF;
  IF OLD.status<>'approved' OR NEW.status NOT IN('revoked','expired') THEN
    RAISE EXCEPTION 'invalid qixiang approval evidence transition';END IF;
  IF NEW.status='revoked' AND NOT qixiang_active_operator(NEW.revoked_by_operator_id)THEN
    RAISE EXCEPTION 'qixiang approval evidence requires active revoker';END IF;RETURN NEW;
END; $$;
CREATE TRIGGER qixiang_provider_approval_evidence_guard BEFORE INSERT OR UPDATE ON qixiang_provider_approval_evidence
  FOR EACH ROW EXECUTE FUNCTION protect_qixiang_provider_approval_evidence();
CREATE TRIGGER qixiang_provider_approval_evidence_no_delete BEFORE DELETE ON qixiang_provider_approval_evidence
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();

CREATE TABLE qixiang_refund_requests(
  id uuid PRIMARY KEY,topup_id uuid NOT NULL REFERENCES kai_credit_topups(id),subject_id uuid NOT NULL REFERENCES trading_subjects(id),
  provider_reference text NOT NULL,provider_payment_id text NOT NULL,provider_transaction_id text NOT NULL,
  amount_cents bigint NOT NULL CHECK(amount_cents>0),credit_micros bigint NOT NULL CHECK(credit_micros>0 AND credit_micros%10000=0),
  status text NOT NULL CHECK(status IN('requested','approved','provider_pending','pending_confirmation','manual_review','confirmed','rejected')),
  version integer NOT NULL DEFAULT 1 CHECK(version>0),reason_code text NOT NULL CHECK(reason_code IN(
    'customer_request','service_unavailable','duplicate_payment','fraud_confirmed','other')),
  request_evidence_digest text NOT NULL CHECK(request_evidence_digest~'^[0-9a-f]{64}$'),
  approval_evidence_digest text CHECK(approval_evidence_digest IS NULL OR approval_evidence_digest~'^[0-9a-f]{64}$'),
  confirmation_evidence_digest text CHECK(confirmation_evidence_digest IS NULL OR confirmation_evidence_digest~'^[0-9a-f]{64}$'),
  requested_by_operator_id uuid NOT NULL REFERENCES users(id),approved_by_operator_id uuid REFERENCES users(id),
  confirmed_by_operator_id uuid REFERENCES users(id),provider_response_code integer CHECK(provider_response_code IN(0,1)),
  provider_response_digest text CHECK(provider_response_digest IS NULL OR provider_response_digest~'^[0-9a-f]{64}$'),
  provider_call_id text,hold_transaction_id uuid UNIQUE REFERENCES kai_credit_transactions(id),
  reversal_transaction_id uuid UNIQUE REFERENCES kai_credit_transactions(id),client_request_id text NOT NULL,
  payload_digest text NOT NULL CHECK(payload_digest~'^[0-9a-f]{64}$'),
  requested_at timestamptz NOT NULL,approved_at timestamptz,provider_submitted_at timestamptz,confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(requested_by_operator_id,client_request_id),UNIQUE(provider_call_id),
  CHECK(approved_by_operator_id IS NULL OR approved_by_operator_id<>requested_by_operator_id),
  CHECK(confirmed_by_operator_id IS NULL OR confirmed_by_operator_id<>requested_by_operator_id),
  CHECK((approved_by_operator_id IS NULL)=(approval_evidence_digest IS NULL)
    AND(approved_by_operator_id IS NULL)=(approved_at IS NULL)),
  CHECK((confirmed_by_operator_id IS NULL)=(confirmation_evidence_digest IS NULL)
    AND(confirmed_by_operator_id IS NULL)=(confirmed_at IS NULL)),
  CHECK((provider_call_id IS NULL)=(provider_submitted_at IS NULL)),
  CHECK((provider_response_code IS NULL)=(provider_response_digest IS NULL)));
CREATE UNIQUE INDEX qixiang_refund_requests_active_topup ON qixiang_refund_requests(topup_id)
  WHERE status NOT IN('confirmed','rejected');
CREATE TABLE qixiang_refund_actions(
  id uuid PRIMARY KEY,refund_id uuid NOT NULL REFERENCES qixiang_refund_requests(id),actor_id uuid NOT NULL REFERENCES users(id),
  action text NOT NULL CHECK(action IN('request','approve','reject','submit','confirm','mark_manual_review')),
  idempotency_owner text NOT NULL,scope text NOT NULL,idempotency_key text NOT NULL,
  payload_digest text NOT NULL CHECK(payload_digest~'^[0-9a-f]{64}$'),
  evidence_digest text CHECK(evidence_digest IS NULL OR evidence_digest~'^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(idempotency_owner,scope,idempotency_key));
CREATE FUNCTION validate_qixiang_refund_operators() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NOT qixiang_active_operator(NEW.requested_by_operator_id)THEN
      RAISE EXCEPTION 'qixiang refund requires active requester';END IF;
    IF NEW.status<>'requested' OR NEW.approved_by_operator_id IS NOT NULL OR NEW.approval_evidence_digest IS NOT NULL
      OR NEW.approved_at IS NOT NULL OR NEW.confirmed_by_operator_id IS NOT NULL
      OR NEW.confirmation_evidence_digest IS NOT NULL OR NEW.confirmed_at IS NOT NULL
      OR NEW.provider_call_id IS NOT NULL OR NEW.provider_submitted_at IS NOT NULL
      OR NEW.provider_response_code IS NOT NULL OR NEW.provider_response_digest IS NOT NULL
      OR NEW.reversal_transaction_id IS NOT NULL THEN
      RAISE EXCEPTION 'qixiang refund must begin at requested without future-stage evidence';END IF;
  END IF;
  IF TG_OP='UPDATE' AND OLD.approved_by_operator_id IS NULL AND NEW.approved_by_operator_id IS NOT NULL
    AND NOT qixiang_active_operator(NEW.approved_by_operator_id)THEN
    RAISE EXCEPTION 'qixiang refund requires active approver';END IF;
  IF TG_OP='UPDATE' AND OLD.confirmed_by_operator_id IS NULL AND NEW.confirmed_by_operator_id IS NOT NULL
    AND NOT qixiang_active_operator(NEW.confirmed_by_operator_id)THEN
    RAISE EXCEPTION 'qixiang refund requires active confirmer';END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER qixiang_refund_requests_operator_guard BEFORE INSERT OR UPDATE ON qixiang_refund_requests
  FOR EACH ROW EXECUTE FUNCTION validate_qixiang_refund_operators();
CREATE FUNCTION validate_qixiang_refund_action_operator() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT qixiang_active_operator(NEW.actor_id)THEN
    RAISE EXCEPTION 'qixiang refund action requires active operator actor';END IF;RETURN NEW;
END; $$;
CREATE TRIGGER qixiang_refund_actions_operator_guard BEFORE INSERT ON qixiang_refund_actions
  FOR EACH ROW EXECUTE FUNCTION validate_qixiang_refund_action_operator();
CREATE TRIGGER qixiang_refund_actions_immutable BEFORE UPDATE OR DELETE ON qixiang_refund_actions
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE FUNCTION protect_qixiang_refund_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id<>OLD.id OR NEW.topup_id<>OLD.topup_id OR NEW.subject_id<>OLD.subject_id OR NEW.provider_reference<>OLD.provider_reference
    OR NEW.provider_payment_id<>OLD.provider_payment_id OR NEW.provider_transaction_id<>OLD.provider_transaction_id
    OR NEW.amount_cents<>OLD.amount_cents OR NEW.credit_micros<>OLD.credit_micros OR NEW.reason_code<>OLD.reason_code
    OR NEW.request_evidence_digest<>OLD.request_evidence_digest OR NEW.requested_by_operator_id<>OLD.requested_by_operator_id
    OR NEW.client_request_id<>OLD.client_request_id OR NEW.payload_digest<>OLD.payload_digest OR NEW.requested_at<>OLD.requested_at
    OR NEW.created_at<>OLD.created_at THEN RAISE EXCEPTION 'qixiang refund identity is immutable';END IF;
  IF OLD.approved_by_operator_id IS NOT NULL AND(
      NEW.approved_by_operator_id IS DISTINCT FROM OLD.approved_by_operator_id
      OR NEW.approval_evidence_digest IS DISTINCT FROM OLD.approval_evidence_digest
      OR NEW.approved_at IS DISTINCT FROM OLD.approved_at)THEN
    RAISE EXCEPTION 'qixiang refund approval history is immutable';END IF;
  IF OLD.approved_by_operator_id IS NULL AND NEW.approved_by_operator_id IS NOT NULL AND NOT(
      OLD.status='requested' AND NEW.status='approved' AND NEW.approval_evidence_digest IS NOT NULL
      AND NEW.approved_at IS NOT NULL)THEN RAISE EXCEPTION 'qixiang refund approval phase mismatch';END IF;
  IF OLD.confirmed_by_operator_id IS NOT NULL AND(
      NEW.confirmed_by_operator_id IS DISTINCT FROM OLD.confirmed_by_operator_id
      OR NEW.confirmation_evidence_digest IS DISTINCT FROM OLD.confirmation_evidence_digest
      OR NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at)THEN
    RAISE EXCEPTION 'qixiang refund confirmation history is immutable';END IF;
  IF OLD.confirmed_by_operator_id IS NULL AND NEW.confirmed_by_operator_id IS NOT NULL AND NOT(
      NEW.status='confirmed' AND NEW.confirmation_evidence_digest IS NOT NULL AND NEW.confirmed_at IS NOT NULL)THEN
    RAISE EXCEPTION 'qixiang refund confirmation phase mismatch';END IF;
  IF OLD.provider_call_id IS NOT NULL AND(NEW.provider_call_id IS DISTINCT FROM OLD.provider_call_id
      OR NEW.provider_submitted_at IS DISTINCT FROM OLD.provider_submitted_at)THEN
    RAISE EXCEPTION 'qixiang refund provider call history is immutable';END IF;
  IF OLD.provider_call_id IS NULL AND NEW.provider_call_id IS NOT NULL AND NOT(
      OLD.status='approved' AND NEW.status IN('provider_pending','manual_review') AND NEW.provider_submitted_at IS NOT NULL)THEN
    RAISE EXCEPTION 'qixiang refund provider call phase mismatch';END IF;
  IF OLD.provider_response_code IS NOT NULL AND(NEW.provider_response_code IS DISTINCT FROM OLD.provider_response_code
      OR NEW.provider_response_digest IS DISTINCT FROM OLD.provider_response_digest)THEN
    RAISE EXCEPTION 'qixiang refund provider response history is immutable';END IF;
  IF OLD.provider_response_code IS NULL AND NEW.provider_response_code IS NOT NULL AND NOT(
      NEW.status='pending_confirmation' AND NEW.provider_response_digest IS NOT NULL)THEN
    RAISE EXCEPTION 'qixiang refund provider response phase mismatch';END IF;
  IF OLD.reversal_transaction_id IS NOT NULL AND NEW.reversal_transaction_id IS DISTINCT FROM OLD.reversal_transaction_id THEN
    RAISE EXCEPTION 'qixiang refund resolution transaction is immutable';END IF;
  IF OLD.reversal_transaction_id IS NULL AND NEW.reversal_transaction_id IS NOT NULL
    AND NEW.status NOT IN('confirmed','rejected')THEN
    RAISE EXCEPTION 'qixiang refund resolution transaction phase mismatch';END IF;
  IF NEW.status IN('requested','approved','provider_pending','pending_confirmation','manual_review')
    AND NEW.reversal_transaction_id IS NOT NULL THEN
    RAISE EXCEPTION 'qixiang refund nonterminal state cannot hold a resolution transaction';END IF;
  IF NOT((OLD.status='requested' AND NEW.status IN('approved','rejected'))
    OR(OLD.status='approved' AND NEW.status IN('provider_pending','manual_review'))
    OR(OLD.status='provider_pending' AND NEW.status IN('pending_confirmation','manual_review'))
    OR(OLD.status='pending_confirmation' AND NEW.status IN('confirmed','manual_review'))
    OR(OLD.status='manual_review' AND NEW.status IN('pending_confirmation','confirmed'))) THEN
    RAISE EXCEPTION 'invalid qixiang refund transition';END IF;
  NEW.version=OLD.version+1;NEW.updated_at=now();RETURN NEW;
END; $$;
CREATE TRIGGER qixiang_refund_requests_guard BEFORE UPDATE ON qixiang_refund_requests
  FOR EACH ROW EXECUTE FUNCTION protect_qixiang_refund_request();
CREATE TRIGGER qixiang_refund_requests_no_delete BEFORE DELETE ON qixiang_refund_requests
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();

CREATE FUNCTION enforce_qixiang_refund_closure() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE topup_row kai_credit_topups%ROWTYPE;hold_count integer;resolution_count integer;
BEGIN
  SELECT * INTO topup_row FROM kai_credit_topups WHERE id=NEW.topup_id;
  IF NOT FOUND OR topup_row.provider<>'qixiang' OR topup_row.status<>'succeeded'
    OR NEW.subject_id<>topup_row.subject_id OR NEW.provider_reference<>topup_row.provider_reference
    OR NEW.provider_payment_id<>topup_row.provider_payment_id
    OR NEW.provider_transaction_id<>topup_row.provider_transaction_id
    OR NEW.amount_cents<>topup_row.amount_cents OR NEW.credit_micros<>topup_row.credit_micros THEN
    RAISE EXCEPTION 'QIXIANG_REFUND_TOPUP_MISMATCH';END IF;
  SELECT count(*) INTO hold_count FROM kai_credit_lot_movements m JOIN kai_credit_lots l ON l.id=m.lot_id
    WHERE l.source_topup_id=NEW.topup_id AND m.kind='refund_hold' AND m.amount_micros=NEW.credit_micros
      AND m.ledger_transaction_id=NEW.hold_transaction_id;
  IF NEW.hold_transaction_id IS NULL OR hold_count<>1 THEN RAISE EXCEPTION 'QIXIANG_REFUND_HOLD_MISSING';END IF;
  IF NEW.status IN('approved','provider_pending','pending_confirmation','manual_review','confirmed')
    AND(NEW.approved_by_operator_id IS NULL OR NEW.approved_by_operator_id=NEW.requested_by_operator_id
      OR NEW.approval_evidence_digest IS NULL)THEN RAISE EXCEPTION 'QIXIANG_REFUND_APPROVAL_MISSING';END IF;
  IF NEW.status IN('provider_pending','pending_confirmation') AND(NEW.provider_call_id IS NULL
    OR NEW.provider_submitted_at IS NULL)THEN RAISE EXCEPTION 'QIXIANG_REFUND_PROVIDER_CALL_MISSING';END IF;
  IF NEW.status='pending_confirmation' AND(NEW.provider_response_code IS NULL
    OR NEW.provider_response_digest IS NULL)THEN RAISE EXCEPTION 'QIXIANG_REFUND_PROVIDER_RESPONSE_MISSING';END IF;
  IF NEW.status IN('confirmed','rejected') THEN
    SELECT count(*) INTO resolution_count FROM kai_credit_lot_movements m JOIN kai_credit_lots l ON l.id=m.lot_id
      WHERE l.source_topup_id=NEW.topup_id AND m.ledger_transaction_id=NEW.reversal_transaction_id
        AND m.amount_micros=NEW.credit_micros
        AND m.kind=CASE WHEN NEW.status='confirmed' THEN 'refund_confirm'
          WHEN l.expires_at<=NEW.updated_at THEN 'refund_release_expired' ELSE 'refund_release_available' END;
    IF NEW.reversal_transaction_id IS NULL OR resolution_count<>1 THEN
      RAISE EXCEPTION 'QIXIANG_REFUND_RESOLUTION_MISSING';END IF;
  END IF;
  IF NEW.status='confirmed' AND(NEW.confirmed_by_operator_id IS NULL
    OR NEW.confirmed_by_operator_id=NEW.requested_by_operator_id OR NEW.confirmation_evidence_digest IS NULL
    OR NEW.confirmed_at IS NULL OR topup_row.reversed_amount_cents<>topup_row.amount_cents
    OR topup_row.reversed_credit_micros<>topup_row.credit_micros)THEN
    RAISE EXCEPTION 'QIXIANG_REFUND_CONFIRMATION_MISSING';END IF;
  RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER qixiang_refund_requests_closure AFTER INSERT OR UPDATE ON qixiang_refund_requests
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_qixiang_refund_closure();

CREATE FUNCTION enforce_qixiang_topup_closure() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE closure_topup_id uuid;topup_row kai_credit_topups%ROWTYPE;receipt_row qixiang_payment_receipts%ROWTYPE;
DECLARE matching_count integer;event_count integer;claim_count integer;lot_count integer;movement_count integer;
DECLARE paid_query_count integer;
DECLARE lot_row kai_credit_lots%ROWTYPE;transaction_row kai_credit_transactions%ROWTYPE;
DECLARE entry_count integer;available_amount bigint;issuance_amount bigint;other_amount bigint;
DECLARE event_payload jsonb;unpaid_count integer;first_unpaid timestamptz;last_unpaid timestamptz;
DECLARE trigger_receipt_id uuid;trigger_movement_kind text;previous_topup_status text;
BEGIN
  CASE TG_TABLE_NAME
    WHEN 'kai_credit_topups' THEN
      closure_topup_id=NEW.id;
      IF TG_OP='UPDATE' THEN previous_topup_status=OLD.status;END IF;
    WHEN 'qixiang_payment_receipts' THEN closure_topup_id=NEW.topup_id;trigger_receipt_id=NEW.id;
    WHEN 'kai_credit_topup_provider_claims' THEN closure_topup_id=NEW.topup_id;
    WHEN 'kai_credit_topup_events' THEN closure_topup_id=NEW.topup_id;
    WHEN 'kai_credit_lots' THEN closure_topup_id=NEW.source_topup_id;
    WHEN 'kai_credit_lot_movements' THEN
      trigger_movement_kind=NEW.kind;
      SELECT source_topup_id INTO closure_topup_id FROM kai_credit_lots WHERE id=NEW.lot_id;
    WHEN 'kai_credit_transactions' THEN
      SELECT source_topup_id INTO closure_topup_id FROM kai_credit_lots WHERE grant_transaction_id=NEW.id;
    WHEN 'kai_credit_entries' THEN
      SELECT l.source_topup_id INTO closure_topup_id FROM kai_credit_lots l
        WHERE l.grant_transaction_id=NEW.transaction_id;
  END CASE;
  IF closure_topup_id IS NULL THEN RETURN NULL;END IF;
  SELECT * INTO topup_row FROM kai_credit_topups WHERE id=closure_topup_id;
  IF NOT FOUND OR topup_row.provider<>'qixiang' THEN RETURN NULL;END IF;
  IF trigger_receipt_id IS NOT NULL AND trigger_receipt_id IS DISTINCT FROM topup_row.success_receipt_id THEN RETURN NULL;END IF;
  IF trigger_movement_kind IS NOT NULL AND trigger_movement_kind<>'grant' THEN RETURN NULL;END IF;
  IF previous_topup_status='succeeded' THEN RETURN NULL;END IF;

  IF topup_row.status='expired' THEN
    SELECT count(*),min(received_at),max(received_at) INTO unpaid_count,first_unpaid,last_unpaid
      FROM qixiang_payment_receipts WHERE topup_id=topup_row.id AND source='query'
      AND provider_code=1 AND provider_status=0 AND payment_type='alipay'
      AND provider_reference=topup_row.provider_reference AND amount_cents=topup_row.amount_cents
      AND snapshot_matched=true AND processing_result='accepted';
    IF topup_row.expires_at>now() OR unpaid_count<2 OR last_unpaid-first_unpaid<interval '30 seconds'
      OR topup_row.unpaid_query_confirmations<>unpaid_count
      OR topup_row.first_unpaid_query_at IS DISTINCT FROM first_unpaid
      OR topup_row.last_unpaid_query_at IS DISTINCT FROM last_unpaid THEN
      RAISE EXCEPTION 'QIXIANG_TOPUP_EXPIRY_EVIDENCE_MISSING';END IF;
  END IF;

  IF topup_row.status<>'succeeded' THEN
    IF topup_row.success_receipt_id IS NOT NULL
      OR EXISTS(SELECT 1 FROM kai_credit_topup_provider_claims WHERE topup_id=topup_row.id)
      OR EXISTS(SELECT 1 FROM kai_credit_topup_events WHERE provider='qixiang' AND topup_id=topup_row.id
        AND processing_result='succeeded')
      OR EXISTS(SELECT 1 FROM kai_credit_lots WHERE source_topup_id=topup_row.id)THEN
      RAISE EXCEPTION 'QIXIANG_TOPUP_PREMATURE_ECONOMIC_WRITE';END IF;
    RETURN NULL;
  END IF;

  SELECT * INTO receipt_row FROM qixiang_payment_receipts WHERE id=topup_row.success_receipt_id;
  IF NOT FOUND OR receipt_row.topup_id IS DISTINCT FROM topup_row.id
    OR receipt_row.provider_reference IS DISTINCT FROM topup_row.provider_reference
    OR receipt_row.trade_no IS DISTINCT FROM topup_row.provider_payment_id
    OR receipt_row.trade_no IS DISTINCT FROM topup_row.provider_transaction_id
    OR receipt_row.payment_type IS DISTINCT FROM 'alipay' OR receipt_row.amount_cents IS DISTINCT FROM topup_row.amount_cents
    OR receipt_row.snapshot_matched IS DISTINCT FROM true OR receipt_row.processing_result IS DISTINCT FROM 'accepted'
    OR receipt_row.payload_digest!~'^[0-9a-f]{64}$' OR receipt_row.source IS DISTINCT FROM topup_row.success_confirmation_source THEN
    RAISE EXCEPTION 'QIXIANG_TOPUP_SUCCESS_RECEIPT_MISMATCH';END IF;

  SELECT count(*) INTO paid_query_count FROM qixiang_payment_receipts query_receipt
    WHERE query_receipt.topup_id=topup_row.id AND query_receipt.source='query'
    AND query_receipt.provider_reference=topup_row.provider_reference
    AND query_receipt.trade_no=topup_row.provider_payment_id
    AND query_receipt.trade_no=topup_row.provider_transaction_id
    AND query_receipt.api_trade_no IS NOT NULL AND query_receipt.provider_code=1
    AND query_receipt.provider_status=1 AND query_receipt.trade_status IS NULL
    AND query_receipt.payment_type='alipay' AND query_receipt.amount_cents=topup_row.amount_cents
    AND query_receipt.signature_verified=false AND query_receipt.snapshot_matched=true
    AND query_receipt.processing_result='accepted' AND query_receipt.payload_digest~'^[0-9a-f]{64}$';
  IF paid_query_count<1 THEN RAISE EXCEPTION 'QIXIANG_TOPUP_PAID_QUERY_CONFIRMATION_MISSING';END IF;

  SELECT count(*) INTO claim_count FROM kai_credit_topup_provider_claims WHERE provider='qixiang'
    AND provider_transaction_id=receipt_row.trade_no AND topup_id=topup_row.id;
  IF claim_count<>1 OR(SELECT count(*) FROM kai_credit_topup_provider_claims WHERE topup_id=topup_row.id)<>1 THEN
    RAISE EXCEPTION 'QIXIANG_TOPUP_SUCCESS_CLAIM_MISSING';END IF;

  event_payload=jsonb_build_object('source',receipt_row.source,'providerReference',topup_row.provider_reference,
    'providerTransactionId',topup_row.provider_transaction_id,'paymentType','alipay','amountCents',topup_row.amount_cents,
    'confirmation',CASE receipt_row.source WHEN 'callback' THEN 'TRADE_SUCCESS' ELSE 'QUERY_PAID' END);
  SELECT count(*) INTO event_count FROM kai_credit_topup_events WHERE provider='qixiang'
    AND provider_event_id='qixiang:'||receipt_row.source||':'||receipt_row.receipt_key
    AND topup_id=topup_row.id AND provider_transaction_id=topup_row.provider_transaction_id
    AND status='succeeded' AND amount_cents=topup_row.amount_cents AND currency=topup_row.currency
    AND payload_digest=receipt_row.payload_digest AND processing_result='succeeded'
    AND normalized_payload=event_payload;
  IF event_count<>1 OR(SELECT count(*) FROM kai_credit_topup_events WHERE provider='qixiang'
    AND topup_id=topup_row.id AND processing_result='succeeded')<>1 THEN
    RAISE EXCEPTION 'QIXIANG_TOPUP_SUCCESS_EVENT_MISSING';END IF;

  SELECT count(*) INTO lot_count FROM kai_credit_lots WHERE source_topup_id=topup_row.id;
  IF lot_count<>1 THEN RAISE EXCEPTION 'QIXIANG_TOPUP_SUCCESS_LOT_MISSING';END IF;
  SELECT * INTO lot_row FROM kai_credit_lots WHERE source_topup_id=topup_row.id;
  SELECT * INTO transaction_row FROM kai_credit_transactions WHERE id=lot_row.grant_transaction_id;
  IF transaction_row.status IS DISTINCT FROM 'posted'
    OR transaction_row.idempotency_owner IS DISTINCT FROM 'subject:'||topup_row.subject_id::text
    OR transaction_row.scope IS DISTINCT FROM 'QIXIANG_TOPUP_CAPTURE'
    OR transaction_row.idempotency_key IS DISTINCT FROM 'qixiang-topup:'||topup_row.id::text
    OR transaction_row.reference_type IS DISTINCT FROM 'topup'
    OR transaction_row.reference_id IS DISTINCT FROM topup_row.id::text
    OR transaction_row.payload_digest!~'^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'QIXIANG_TOPUP_GRANT_TRANSACTION_MISMATCH';END IF;
  SELECT count(*),COALESCE(sum(e.amount_micros)FILTER(WHERE a.subject_id=topup_row.subject_id
      AND a.account_kind='available'),0),
    COALESCE(sum(e.amount_micros)FILTER(WHERE a.id='00000000-0000-4000-8000-000000000101'),0),
    COALESCE(sum(e.amount_micros)FILTER(WHERE NOT(a.subject_id=topup_row.subject_id AND a.account_kind='available')
      AND a.id<>'00000000-0000-4000-8000-000000000101'),0)
    INTO entry_count,available_amount,issuance_amount,other_amount
    FROM kai_credit_entries e JOIN kai_credit_accounts a ON a.id=e.account_id
    WHERE e.transaction_id=transaction_row.id;
  IF entry_count<>2 OR available_amount<>topup_row.credit_micros OR issuance_amount<>-topup_row.credit_micros
    OR other_amount<>0 THEN RAISE EXCEPTION 'QIXIANG_TOPUP_GRANT_ENTRIES_MISMATCH';END IF;
  IF lot_row.subject_id IS DISTINCT FROM topup_row.subject_id OR lot_row.source_kind<>'qixiang_topup'
    OR lot_row.granted_micros<>topup_row.credit_micros OR lot_row.available_micros<>topup_row.credit_micros
    OR lot_row.reserved_micros<>0 OR lot_row.refund_pending_micros<>0 OR lot_row.consumed_micros<>0
    OR lot_row.expired_micros<>0 OR lot_row.refunded_micros<>0
    OR lot_row.created_at IS DISTINCT FROM topup_row.succeeded_at
    OR lot_row.expires_at IS DISTINCT FROM topup_row.entitlement_expires_at THEN
    RAISE EXCEPTION 'QIXIANG_TOPUP_SUCCESS_LOT_MISMATCH';END IF;
  SELECT count(*) INTO movement_count FROM kai_credit_lot_movements WHERE lot_id=lot_row.id
    AND allocation_id IS NULL AND ledger_transaction_id=transaction_row.id AND kind='grant'
    AND amount_micros=topup_row.credit_micros AND from_bucket IS NULL AND to_bucket='available'
    AND idempotency_owner=transaction_row.idempotency_owner AND scope=transaction_row.scope
    AND idempotency_key=transaction_row.idempotency_key AND payload_digest=transaction_row.payload_digest;
  IF movement_count<>1 OR(SELECT count(*) FROM kai_credit_lot_movements WHERE lot_id=lot_row.id AND kind='grant')<>1 THEN
    RAISE EXCEPTION 'QIXIANG_TOPUP_SUCCESS_GRANT_MOVEMENT_MISMATCH';END IF;
  RETURN NULL;
END; $$;

CREATE CONSTRAINT TRIGGER qixiang_topups_closure AFTER INSERT OR UPDATE ON kai_credit_topups
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_qixiang_topup_closure();
CREATE CONSTRAINT TRIGGER qixiang_receipts_closure AFTER INSERT ON qixiang_payment_receipts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_qixiang_topup_closure();
CREATE CONSTRAINT TRIGGER qixiang_claims_closure AFTER INSERT ON kai_credit_topup_provider_claims
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_qixiang_topup_closure();
CREATE CONSTRAINT TRIGGER qixiang_events_closure AFTER INSERT ON kai_credit_topup_events
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_qixiang_topup_closure();
CREATE CONSTRAINT TRIGGER qixiang_lots_closure AFTER INSERT ON kai_credit_lots
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_qixiang_topup_closure();
CREATE CONSTRAINT TRIGGER qixiang_movements_closure AFTER INSERT ON kai_credit_lot_movements
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_qixiang_topup_closure();
CREATE CONSTRAINT TRIGGER qixiang_transactions_closure AFTER INSERT OR UPDATE ON kai_credit_transactions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_qixiang_topup_closure();
CREATE CONSTRAINT TRIGGER qixiang_entries_closure AFTER INSERT ON kai_credit_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_qixiang_topup_closure();

CREATE FUNCTION enforce_qixiang_movement_ledger_matrix() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE transaction_id_value uuid;tx kai_credit_transactions%ROWTYPE;buyer_subject uuid;movement_rows integer;
DECLARE movement_subject_count integer;allocation_type_count integer;allocation_ref_count integer;
DECLARE allocation_type text;allocation_ref uuid;order_buyer uuid;order_supplier uuid;
DECLARE grant_m bigint;reserve_m bigint;consume_m bigint;release_available_m bigint;release_expired_m bigint;
DECLARE restore_available_m bigint;restore_expired_m bigint;refund_hold_m bigint;
DECLARE refund_release_available_m bigint;refund_release_expired_m bigint;refund_confirm_m bigint;expire_m bigint;
DECLARE entry_rows integer;buyer_available bigint;buyer_reserved bigint;buyer_hold bigint;
DECLARE issuance bigint;clearing bigint;revenue bigint;supplier_receivable bigint;supplier_earnings bigint;
DECLARE unexpected_rows integer;total_value bigint;captured_value bigint;expired_value bigint;
BEGIN
  IF TG_TABLE_NAME='kai_credit_lot_movements' THEN transaction_id_value=NEW.ledger_transaction_id;
  ELSIF TG_TABLE_NAME='kai_credit_entries' THEN transaction_id_value=NEW.transaction_id;
  ELSIF TG_TABLE_NAME='kai_credit_transactions' THEN transaction_id_value=NEW.id;
  ELSE RETURN NULL;END IF;
  SELECT * INTO tx FROM kai_credit_transactions WHERE id=transaction_id_value;
  IF NOT FOUND THEN RETURN NULL;END IF;
  SELECT count(*),count(DISTINCT l.subject_id),(array_agg(l.subject_id))[1],
    COALESCE(sum(m.amount_micros)FILTER(WHERE m.kind='grant'),0),
    COALESCE(sum(m.amount_micros)FILTER(WHERE m.kind='reserve'),0),
    COALESCE(sum(m.amount_micros)FILTER(WHERE m.kind='consume'),0),
    COALESCE(sum(m.amount_micros)FILTER(WHERE m.kind='release_available'),0),
    COALESCE(sum(m.amount_micros)FILTER(WHERE m.kind='release_expired'),0),
    COALESCE(sum(m.amount_micros)FILTER(WHERE m.kind='restore_available'),0),
    COALESCE(sum(m.amount_micros)FILTER(WHERE m.kind='restore_expired'),0),
    COALESCE(sum(m.amount_micros)FILTER(WHERE m.kind='refund_hold'),0),
    COALESCE(sum(m.amount_micros)FILTER(WHERE m.kind='refund_release_available'),0),
    COALESCE(sum(m.amount_micros)FILTER(WHERE m.kind='refund_release_expired'),0),
    COALESCE(sum(m.amount_micros)FILTER(WHERE m.kind='refund_confirm'),0),
    COALESCE(sum(m.amount_micros)FILTER(WHERE m.kind='expire'),0)
    INTO movement_rows,movement_subject_count,buyer_subject,grant_m,reserve_m,consume_m,
      release_available_m,release_expired_m,restore_available_m,restore_expired_m,refund_hold_m,
      refund_release_available_m,refund_release_expired_m,refund_confirm_m,expire_m
    FROM kai_credit_lot_movements m JOIN kai_credit_lots l ON l.id=m.lot_id
    WHERE m.ledger_transaction_id=transaction_id_value;
  IF movement_rows=0 THEN
    IF tx.scope IN('CREDIT_ORDER_RESERVE','VAST_ORDER_RESERVE','CREDIT_ORDER_CAPTURE','VAST_ORDER_CAPTURE',
      'COMPUTE_METERED_CAPTURE','COMPUTE_ISSUE_DECISION','CREDIT_ORDER_RELEASE','COMPUTE_PROVISION_FAILURE_RELEASE',
      'CREDIT_ORDER_MUTUAL_REFUND','CREDIT_ORDER_ADJUDICATED_REFUND','VAST_ORDER_RELEASE',
      'CREDIT_ORDER_POST_ACCEPT_REFUND','CREDIT_ORDER_POST_ACCEPT_ADJUDICATED_REFUND',
      'CREDIT_SETTLEMENT_REFUND_WITH_FEE_REVERSAL') AND EXISTS(
        SELECT 1 FROM kai_credit_lot_allocations a WHERE a.reference_id::text=tx.reference_id)THEN
      RAISE EXCEPTION 'QIXIANG_LOT_SETTLEMENT_MOVEMENT_MISSING';END IF;
    IF tx.scope NOT IN('CREDIT_ORDER_RESERVE','VAST_ORDER_RESERVE','CREDIT_ORDER_CAPTURE','VAST_ORDER_CAPTURE',
      'COMPUTE_METERED_CAPTURE','COMPUTE_ISSUE_DECISION','CREDIT_ORDER_RELEASE','COMPUTE_PROVISION_FAILURE_RELEASE',
      'CREDIT_ORDER_MUTUAL_REFUND','CREDIT_ORDER_ADJUDICATED_REFUND','VAST_ORDER_RELEASE',
      'CREDIT_ORDER_POST_ACCEPT_REFUND','CREDIT_ORDER_POST_ACCEPT_ADJUDICATED_REFUND',
      'CREDIT_SETTLEMENT_REFUND_WITH_FEE_REVERSAL')THEN RETURN NULL;END IF;
    IF tx.idempotency_owner!~'^subject:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'THEN
      RAISE EXCEPTION 'QIXIANG_LOT_LEDGER_SUBJECT_OR_STATUS';END IF;
    buyer_subject=substring(tx.idempotency_owner FROM 9)::uuid;
  END IF;
  IF(movement_rows>0 AND movement_subject_count<>1)OR tx.status<>'posted' THEN
    RAISE EXCEPTION 'QIXIANG_LOT_LEDGER_SUBJECT_OR_STATUS';END IF;
  IF EXISTS(SELECT 1 FROM kai_credit_lot_movements m WHERE m.ledger_transaction_id=transaction_id_value
    AND(m.idempotency_owner<>tx.idempotency_owner OR m.scope<>tx.scope OR m.idempotency_key<>tx.idempotency_key
      OR m.payload_digest<>tx.payload_digest))THEN RAISE EXCEPTION 'QIXIANG_LOT_LEDGER_IDEMPOTENCY_MISMATCH';END IF;
  SELECT count(DISTINCT a.reference_type),count(DISTINCT a.reference_id),min(a.reference_type),(array_agg(a.reference_id))[1]
    INTO allocation_type_count,allocation_ref_count,allocation_type,allocation_ref
    FROM kai_credit_lot_movements m JOIN kai_credit_lot_allocations a ON a.id=m.allocation_id
    WHERE m.ledger_transaction_id=transaction_id_value;
  IF COALESCE(allocation_type_count,0)>1 OR COALESCE(allocation_ref_count,0)>1
    OR(allocation_ref IS NOT NULL AND allocation_ref::text<>tx.reference_id)THEN
    RAISE EXCEPTION 'QIXIANG_LOT_ALLOCATION_REFERENCE_MISMATCH';END IF;
  IF EXISTS(SELECT 1 FROM kai_credit_entries e JOIN kai_credit_accounts a ON a.id=e.account_id
    WHERE e.transaction_id=transaction_id_value AND a.subject_id IS NOT NULL AND a.subject_id<>buyer_subject
      AND a.account_kind IN('available','reserved','refund_hold'))THEN
    RAISE EXCEPTION 'QIXIANG_LOT_LEDGER_SECOND_BUYER';END IF;
  SELECT count(*),
    COALESCE(sum(e.amount_micros)FILTER(WHERE a.subject_id=buyer_subject AND a.account_kind='available'),0),
    COALESCE(sum(e.amount_micros)FILTER(WHERE a.subject_id=buyer_subject AND a.account_kind='reserved'),0),
    COALESCE(sum(e.amount_micros)FILTER(WHERE a.subject_id=buyer_subject AND a.account_kind='refund_hold'),0),
    COALESCE(sum(e.amount_micros)FILTER(WHERE a.account_kind='platform_issuance'),0),
    COALESCE(sum(e.amount_micros)FILTER(WHERE a.account_kind='platform_clearing'),0),
    COALESCE(sum(e.amount_micros)FILTER(WHERE a.account_kind='platform_revenue'),0),
    COALESCE(sum(e.amount_micros)FILTER(WHERE a.account_kind='supplier_receivable'),0),
    COALESCE(sum(e.amount_micros)FILTER(WHERE a.account_kind='supplier_earnings_available'),0)
    INTO entry_rows,buyer_available,buyer_reserved,buyer_hold,issuance,clearing,revenue,supplier_receivable,supplier_earnings
    FROM kai_credit_entries e JOIN kai_credit_accounts a ON a.id=e.account_id
    WHERE e.transaction_id=transaction_id_value;

  IF grant_m>0 THEN
    IF movement_rows<>1 OR grant_m<=0 OR reserve_m+consume_m+release_available_m+release_expired_m
      +restore_available_m+restore_expired_m+refund_hold_m+refund_release_available_m
      +refund_release_expired_m+refund_confirm_m+expire_m<>0
      OR tx.scope<>'QIXIANG_TOPUP_CAPTURE' OR tx.reference_type<>'topup' OR entry_rows<>2
      OR buyer_available<>grant_m OR issuance<>-grant_m THEN RAISE EXCEPTION 'QIXIANG_LOT_LEDGER_GRANT_MATRIX';END IF;
  ELSIF reserve_m>0 OR tx.scope IN('CREDIT_ORDER_RESERVE','VAST_ORDER_RESERVE') THEN
    IF consume_m+release_available_m+release_expired_m+restore_available_m+restore_expired_m+refund_hold_m
      +refund_release_available_m+refund_release_expired_m+refund_confirm_m+expire_m<>0
      OR tx.scope NOT IN('CREDIT_ORDER_RESERVE','VAST_ORDER_RESERVE') OR tx.reference_type<>'order_reservation'
      OR(movement_rows>0 AND allocation_type IS DISTINCT FROM
        (CASE tx.scope WHEN 'CREDIT_ORDER_RESERVE' THEN 'credit_order' ELSE 'vast_order' END))
      OR entry_rows<>2 OR buyer_available>=0 OR buyer_reserved<>-buyer_available OR reserve_m>-buyer_available THEN
      RAISE EXCEPTION 'QIXIANG_LOT_LEDGER_RESERVE_MATRIX';END IF;
    IF tx.scope='CREDIT_ORDER_RESERVE' THEN
      SELECT buyer_subject_id INTO order_buyer FROM kai_credit_orders WHERE id=tx.reference_id::uuid;
    ELSE
      SELECT buyer_subject_id INTO order_buyer FROM vast_external_orders WHERE id=tx.reference_id::uuid;
    END IF;
    IF order_buyer IS DISTINCT FROM buyer_subject THEN
      RAISE EXCEPTION 'QIXIANG_LOT_LEDGER_RESERVE_REFERENCE';END IF;
  ELSIF consume_m>0 OR tx.scope IN('CREDIT_ORDER_CAPTURE','VAST_ORDER_CAPTURE','COMPUTE_METERED_CAPTURE',
      'COMPUTE_ISSUE_DECISION')THEN
    IF grant_m+reserve_m+restore_available_m+restore_expired_m+refund_hold_m+refund_release_available_m
      +refund_release_expired_m+refund_confirm_m+expire_m<>0 OR buyer_reserved>=0 THEN
      RAISE EXCEPTION 'QIXIANG_LOT_LEDGER_CAPTURE_MATRIX';END IF;
    total_value=-buyer_reserved;
    IF tx.scope='VAST_ORDER_CAPTURE' THEN
      IF tx.reference_type<>'order_capture' OR(movement_rows>0 AND allocation_type IS DISTINCT FROM 'vast_order')
        OR entry_rows<>2
        OR clearing<>total_value OR consume_m>total_value OR release_available_m+release_expired_m<>0 THEN
        RAISE EXCEPTION 'QIXIANG_LOT_LEDGER_VAST_CAPTURE_MATRIX';END IF;
      SELECT buyer_subject_id INTO order_buyer FROM vast_external_orders WHERE id=tx.reference_id::uuid;
      SELECT count(*) INTO unexpected_rows FROM kai_credit_entries e JOIN kai_credit_accounts a ON a.id=e.account_id
        WHERE e.transaction_id=transaction_id_value AND NOT(a.subject_id=buyer_subject AND a.account_kind='reserved')
        AND a.account_kind<>'platform_clearing';
      IF order_buyer IS DISTINCT FROM buyer_subject THEN
        RAISE EXCEPTION 'QIXIANG_LOT_LEDGER_VAST_CAPTURE_COUNTERPART';END IF;
    ELSIF tx.scope='CREDIT_ORDER_CAPTURE' THEN
      IF tx.reference_type<>'order_capture' OR(movement_rows>0 AND allocation_type IS DISTINCT FROM 'credit_order')
        OR release_available_m+release_expired_m<>0 THEN RAISE EXCEPTION 'QIXIANG_LOT_LEDGER_CAPTURE_MATRIX';END IF;
      SELECT buyer_subject_id,supplier_subject_id INTO order_buyer,order_supplier FROM kai_credit_orders WHERE id=tx.reference_id::uuid;
      SELECT count(*) INTO unexpected_rows FROM kai_credit_entries e JOIN kai_credit_accounts a ON a.id=e.account_id
        WHERE e.transaction_id=transaction_id_value AND NOT(
          (a.subject_id=buyer_subject AND a.account_kind='reserved')
          OR(a.subject_id=order_supplier AND a.account_kind='supplier_receivable')
          OR(a.owner_kind='platform' AND a.account_kind='platform_revenue'));
      IF order_buyer IS DISTINCT FROM buyer_subject OR supplier_receivable<>total_value OR revenue<>0
        OR consume_m>total_value THEN RAISE EXCEPTION 'QIXIANG_LOT_LEDGER_CAPTURE_COUNTERPART';END IF;
    ELSIF tx.scope IN('COMPUTE_METERED_CAPTURE','COMPUTE_ISSUE_DECISION') THEN
      IF tx.reference_type NOT IN('order_capture','refund')
        OR(movement_rows>0 AND allocation_type IS DISTINCT FROM 'credit_order')THEN
        RAISE EXCEPTION 'QIXIANG_LOT_LEDGER_METERED_MATRIX';END IF;
      SELECT buyer_subject_id,supplier_subject_id INTO order_buyer,order_supplier FROM kai_credit_orders WHERE id=tx.reference_id::uuid;
      SELECT count(*) INTO unexpected_rows FROM kai_credit_entries e JOIN kai_credit_accounts a ON a.id=e.account_id
        WHERE e.transaction_id=transaction_id_value AND NOT(
          (a.subject_id=buyer_subject AND a.account_kind IN('reserved','available'))
          OR(a.subject_id=order_supplier AND a.account_kind='supplier_receivable')
          OR(a.owner_kind='platform' AND a.account_kind='platform_issuance'));
      captured_value=supplier_receivable;expired_value=issuance;
      IF order_buyer IS DISTINCT FROM buyer_subject OR captured_value<0 OR expired_value<0
        OR buyer_available<>total_value-captured_value-expired_value OR consume_m>captured_value
        OR release_available_m>buyer_available OR release_expired_m<>expired_value THEN
        RAISE EXCEPTION 'QIXIANG_LOT_LEDGER_METERED_COUNTERPART';END IF;
    ELSE RAISE EXCEPTION 'QIXIANG_LOT_LEDGER_CAPTURE_SCOPE';END IF;
    IF unexpected_rows<>0 THEN RAISE EXCEPTION 'QIXIANG_LOT_LEDGER_CAPTURE_EXTRA_ENTRY';END IF;
  ELSIF release_available_m+release_expired_m>0 OR tx.scope IN('CREDIT_ORDER_RELEASE',
      'COMPUTE_PROVISION_FAILURE_RELEASE','CREDIT_ORDER_MUTUAL_REFUND','CREDIT_ORDER_ADJUDICATED_REFUND',
      'VAST_ORDER_RELEASE')THEN
    IF grant_m+reserve_m+consume_m+restore_available_m+restore_expired_m+refund_hold_m
      +refund_release_available_m+refund_release_expired_m+refund_confirm_m+expire_m<>0
      OR tx.scope NOT IN('CREDIT_ORDER_RELEASE','COMPUTE_PROVISION_FAILURE_RELEASE','CREDIT_ORDER_MUTUAL_REFUND',
        'CREDIT_ORDER_ADJUDICATED_REFUND','VAST_ORDER_RELEASE')
      OR tx.reference_type<>(CASE WHEN tx.scope IN('CREDIT_ORDER_MUTUAL_REFUND','CREDIT_ORDER_ADJUDICATED_REFUND')
        THEN 'refund' ELSE 'order_release' END)
      OR(movement_rows>0 AND allocation_type IS DISTINCT FROM
        (CASE WHEN tx.scope='VAST_ORDER_RELEASE' THEN 'vast_order' ELSE 'credit_order' END))
      OR buyer_reserved>=0 THEN
      RAISE EXCEPTION 'QIXIANG_LOT_LEDGER_RELEASE_MATRIX';END IF;
    IF tx.scope='VAST_ORDER_RELEASE' THEN
      SELECT buyer_subject_id INTO order_buyer FROM vast_external_orders WHERE id=tx.reference_id::uuid;
    ELSE
      SELECT buyer_subject_id INTO order_buyer FROM kai_credit_orders WHERE id=tx.reference_id::uuid;
    END IF;
    IF order_buyer IS DISTINCT FROM buyer_subject THEN
      RAISE EXCEPTION 'QIXIANG_LOT_LEDGER_RELEASE_REFERENCE';END IF;
    total_value=-buyer_reserved;expired_value=issuance;
    SELECT count(*) INTO unexpected_rows FROM kai_credit_entries e JOIN kai_credit_accounts a ON a.id=e.account_id
      WHERE e.transaction_id=transaction_id_value AND NOT(
        (a.subject_id=buyer_subject AND a.account_kind IN('reserved','available'))
        OR(a.owner_kind='platform' AND a.account_kind='platform_issuance'));
    IF unexpected_rows<>0 OR buyer_available<>total_value-expired_value OR release_available_m>buyer_available
      OR release_expired_m<>expired_value OR release_available_m+release_expired_m>total_value THEN
      RAISE EXCEPTION 'QIXIANG_LOT_LEDGER_RELEASE_COUNTERPART';END IF;
  ELSIF restore_available_m+restore_expired_m>0 OR tx.scope IN('CREDIT_ORDER_POST_ACCEPT_REFUND',
      'CREDIT_ORDER_POST_ACCEPT_ADJUDICATED_REFUND','CREDIT_SETTLEMENT_REFUND_WITH_FEE_REVERSAL')THEN
    IF grant_m+reserve_m+consume_m+release_available_m+release_expired_m+refund_hold_m
      +refund_release_available_m+refund_release_expired_m+refund_confirm_m+expire_m<>0
      OR tx.scope NOT IN('CREDIT_ORDER_POST_ACCEPT_REFUND','CREDIT_ORDER_POST_ACCEPT_ADJUDICATED_REFUND',
        'CREDIT_SETTLEMENT_REFUND_WITH_FEE_REVERSAL') OR tx.reference_type<>'refund'
      OR(movement_rows>0 AND allocation_type IS DISTINCT FROM 'credit_order')THEN
      RAISE EXCEPTION 'QIXIANG_LOT_LEDGER_RESTORE_MATRIX';END IF;
    SELECT buyer_subject_id,supplier_subject_id INTO order_buyer,order_supplier FROM kai_credit_orders WHERE id=tx.reference_id::uuid;
    SELECT count(*) INTO unexpected_rows FROM kai_credit_entries e JOIN kai_credit_accounts a ON a.id=e.account_id
      WHERE e.transaction_id=transaction_id_value AND NOT(
        (a.subject_id=buyer_subject AND a.account_kind='available')
        OR(a.subject_id=order_supplier AND a.account_kind IN('supplier_receivable','supplier_earnings_available'))
        OR(a.owner_kind='platform' AND a.account_kind IN('platform_revenue','platform_issuance')));
    total_value=-(supplier_receivable+supplier_earnings+revenue);expired_value=issuance;
    IF order_buyer IS DISTINCT FROM buyer_subject OR unexpected_rows<>0 OR total_value<=0
      OR buyer_available<>total_value-expired_value OR restore_available_m>buyer_available
      OR restore_expired_m<>expired_value THEN RAISE EXCEPTION 'QIXIANG_LOT_LEDGER_RESTORE_COUNTERPART';END IF;
  ELSIF refund_hold_m>0 THEN
    IF movement_rows<>1 OR tx.scope<>'QIXIANG_REFUND_HOLD' OR tx.reference_type<>'refund'
      OR entry_rows<>2 OR buyer_available<>-refund_hold_m OR buyer_hold<>refund_hold_m
      OR reserve_m+consume_m+refund_release_available_m+refund_release_expired_m+refund_confirm_m+expire_m<>0
      OR NOT EXISTS(SELECT 1 FROM qixiang_refund_requests r JOIN kai_credit_lots l ON l.source_topup_id=r.topup_id
        JOIN kai_credit_lot_movements m ON m.lot_id=l.id WHERE r.id::text=tx.reference_id
        AND r.credit_micros=refund_hold_m AND m.ledger_transaction_id=tx.id AND r.hold_transaction_id=tx.id)THEN
      RAISE EXCEPTION 'QIXIANG_LOT_LEDGER_REFUND_HOLD_MATRIX';END IF;
  ELSIF refund_release_available_m+refund_release_expired_m>0 THEN
    total_value=refund_release_available_m+refund_release_expired_m;
    IF tx.scope<>'QIXIANG_REFUND_RELEASE' OR tx.reference_type<>'refund' OR buyer_hold<>-total_value
      OR buyer_available<>refund_release_available_m OR issuance<>refund_release_expired_m
      OR entry_rows<>(CASE WHEN refund_release_available_m>0 AND refund_release_expired_m>0 THEN 3 ELSE 2 END)THEN
      RAISE EXCEPTION 'QIXIANG_LOT_LEDGER_REFUND_RELEASE_MATRIX';END IF;
  ELSIF refund_confirm_m>0 THEN
    IF movement_rows<>1 OR tx.scope<>'QIXIANG_REFUND_CONFIRM' OR tx.reference_type<>'refund'
      OR entry_rows<>2 OR buyer_hold<>-refund_confirm_m OR issuance<>refund_confirm_m THEN
      RAISE EXCEPTION 'QIXIANG_LOT_LEDGER_REFUND_CONFIRM_MATRIX';END IF;
  ELSIF expire_m>0 THEN
    IF tx.scope<>'QIXIANG_LOT_EXPIRE' OR tx.reference_type<>'adjustment' OR entry_rows<>2
      OR buyer_available<>-expire_m OR issuance<>expire_m
      OR EXISTS(SELECT 1 FROM kai_credit_lot_movements m JOIN kai_credit_lots l ON l.id=m.lot_id
        WHERE m.ledger_transaction_id=tx.id AND m.kind='expire' AND l.expires_at>m.occurred_at)THEN
      RAISE EXCEPTION 'QIXIANG_LOT_LEDGER_EXPIRE_MATRIX';END IF;
  ELSE RAISE EXCEPTION 'QIXIANG_LOT_LEDGER_KIND_FAMILY_INVALID';END IF;
  IF tx.scope IN('CREDIT_ORDER_CAPTURE','VAST_ORDER_CAPTURE','COMPUTE_METERED_CAPTURE','COMPUTE_ISSUE_DECISION',
      'CREDIT_ORDER_RELEASE','COMPUTE_PROVISION_FAILURE_RELEASE','CREDIT_ORDER_MUTUAL_REFUND',
      'CREDIT_ORDER_ADJUDICATED_REFUND','VAST_ORDER_RELEASE')
    AND EXISTS(SELECT 1 FROM kai_credit_lot_allocations a
      WHERE a.reference_id::text=tx.reference_id AND a.reserved_micros<>0)THEN
    RAISE EXCEPTION 'QIXIANG_LOT_RESERVATION_NOT_FULLY_RESOLVED';END IF;
  RETURN NULL;
END; $$;

CREATE CONSTRAINT TRIGGER qixiang_movement_matrix_on_movement AFTER INSERT ON kai_credit_lot_movements
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_qixiang_movement_ledger_matrix();
CREATE CONSTRAINT TRIGGER qixiang_movement_matrix_on_transaction AFTER INSERT OR UPDATE ON kai_credit_transactions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_qixiang_movement_ledger_matrix();
CREATE CONSTRAINT TRIGGER qixiang_movement_matrix_on_entry AFTER INSERT ON kai_credit_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_qixiang_movement_ledger_matrix();

CREATE FUNCTION enforce_qixiang_global_bucket_floor() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE invalid_subject uuid;
BEGIN
  WITH lot_totals AS(
    SELECT subject_id,sum(available_micros)available,sum(reserved_micros)reserved,
      sum(refund_pending_micros)refund_hold FROM kai_credit_lots GROUP BY subject_id
  ),ledger_totals AS(
    SELECT a.subject_id,
      COALESCE(sum(e.amount_micros)FILTER(WHERE a.account_kind='available'AND t.status='posted'),0)available,
      COALESCE(sum(e.amount_micros)FILTER(WHERE a.account_kind='reserved'AND t.status='posted'),0)reserved,
      COALESCE(sum(e.amount_micros)FILTER(WHERE a.account_kind='refund_hold'AND t.status='posted'),0)refund_hold
    FROM kai_credit_accounts a LEFT JOIN kai_credit_entries e ON e.account_id=a.id
    LEFT JOIN kai_credit_transactions t ON t.id=e.transaction_id
    WHERE a.subject_id IS NOT NULL GROUP BY a.subject_id
  )
  SELECT l.subject_id INTO invalid_subject FROM lot_totals l LEFT JOIN ledger_totals b ON b.subject_id=l.subject_id
  WHERE COALESCE(b.available,0)<l.available OR COALESCE(b.reserved,0)<l.reserved
    OR COALESCE(b.refund_hold,0)<l.refund_hold LIMIT 1;
  IF invalid_subject IS NOT NULL THEN RAISE EXCEPTION 'QIXIANG_LOT_LEDGER_BUCKET_IMBALANCE';END IF;
  RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER qixiang_global_bucket_floor_on_entry AFTER INSERT ON kai_credit_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_qixiang_global_bucket_floor();
CREATE CONSTRAINT TRIGGER qixiang_global_bucket_floor_on_transaction AFTER INSERT OR UPDATE ON kai_credit_transactions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_qixiang_global_bucket_floor();
