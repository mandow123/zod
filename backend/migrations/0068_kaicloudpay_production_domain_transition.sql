-- Append-only evidence-domain transition. Historical approval records stay valid as evidence,
-- but the runtime gate separately requires api.kaicloudpay.com for new production enrollment.
CREATE OR REPLACE FUNCTION validate_qixiang_evidence_metadata(kind_value text,value jsonb) RETURNS boolean
  LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  CASE kind_value
    WHEN 'merchant_key_rotation' THEN RETURN qixiang_json_has_exact_keys(value,ARRAY['credentialVersion','merchantId','newKeyFingerprint','oldKeyFingerprint','rotatedAt'])
      AND qixiang_json_strings(value,ARRAY['credentialVersion','merchantId','newKeyFingerprint','oldKeyFingerprint','rotatedAt'])
      AND value->>'merchantId'='4611' AND qixiang_iso_utc(value->>'rotatedAt')
      AND char_length(value->>'credentialVersion') BETWEEN 1 AND 80
      AND value->>'newKeyFingerprint'~'^[0-9a-f]{64}$' AND value->>'oldKeyFingerprint'~'^[0-9a-f]{64}$'
      AND value->>'newKeyFingerprint'<>value->>'oldKeyFingerprint';
    WHEN 'old_key_revocation' THEN RETURN qixiang_json_has_exact_keys(value,ARRAY['merchantId','oldKeyFingerprint','providerCaseRef','revokedAt'])
      AND qixiang_json_strings(value,ARRAY['merchantId','oldKeyFingerprint','providerCaseRef','revokedAt'])
      AND value->>'merchantId'='4611' AND qixiang_iso_utc(value->>'revokedAt')
      AND value->>'oldKeyFingerprint'~'^[0-9a-f]{64}$' AND char_length(value->>'providerCaseRef') BETWEEN 3 AND 500;
    WHEN 'merchant_entity_match' THEN RETURN qixiang_json_has_exact_keys(value,ARRAY['legalEntityName','merchantId','providerRegisteredName','unifiedSocialCreditCode','verifiedAt'])
      AND qixiang_json_strings(value,ARRAY['legalEntityName','merchantId','providerRegisteredName','unifiedSocialCreditCode','verifiedAt'])
      AND value->>'merchantId'='4611' AND qixiang_iso_utc(value->>'verifiedAt')
      AND char_length(value->>'legalEntityName') BETWEEN 2 AND 200 AND char_length(value->>'providerRegisteredName') BETWEEN 2 AND 200
      AND value->>'unifiedSocialCreditCode'~'^[0-9A-Z]{18}$';
    WHEN 'domain_app_scene_approval' THEN RETURN qixiang_json_has_exact_keys(value,ARRAY['appPackage','approvedAt','domain','merchantId','providerCaseRef','scene'])
      AND qixiang_json_strings(value,ARRAY['appPackage','approvedAt','domain','merchantId','providerCaseRef','scene'])
      AND value->>'merchantId'='4611' AND value->>'domain' IN ('cloudpay.kai.com','api.kaicloudpay.com')
      AND value->>'appPackage'='com.kaicloud.marketplace' AND value->>'scene'='android_h5_alipay'
      AND qixiang_iso_utc(value->>'approvedAt') AND char_length(value->>'providerCaseRef') BETWEEN 3 AND 500;
    WHEN 'service_category_approval' THEN RETURN qixiang_json_has_exact_keys(value,ARRAY['approvedAt','category','entitlementDays','merchantId','nonCash','nonTransferable'])
      AND qixiang_json_strings(value,ARRAY['approvedAt','category','merchantId']) AND jsonb_typeof(value->'entitlementDays')='number'
      AND jsonb_typeof(value->'nonCash')='boolean' AND jsonb_typeof(value->'nonTransferable')='boolean' AND value->>'merchantId'='4611'
      AND value->'entitlementDays'='364'::jsonb AND value->'nonTransferable'='true'::jsonb AND value->'nonCash'='true'::jsonb
      AND qixiang_iso_utc(value->>'approvedAt') AND char_length(value->>'category') BETWEEN 1 AND 200;
    WHEN 'refund_api_confirmation' THEN RETURN qixiang_json_has_exact_keys(value,ARRAY['confirmationRequired','enabledAt','merchantId','providerCaseRef','successCodes','supportsOutTradeNo'])
      AND qixiang_json_strings(value,ARRAY['enabledAt','merchantId','providerCaseRef']) AND jsonb_typeof(value->'confirmationRequired')='boolean'
      AND jsonb_typeof(value->'supportsOutTradeNo')='boolean' AND jsonb_typeof(value->'successCodes')='array' AND value->>'merchantId'='4611'
      AND value->'supportsOutTradeNo'='true'::jsonb AND value->'successCodes'='[0,1]'::jsonb AND value->'confirmationRequired'='true'::jsonb
      AND qixiang_iso_utc(value->>'enabledAt') AND char_length(value->>'providerCaseRef') BETWEEN 3 AND 500;
    WHEN 'real_fulfillment_acceptance' THEN RETURN qixiang_json_has_exact_keys(value,ARRAY['acceptanceReportDigest','fulfillmentType','merchantId','testedAt'])
      AND qixiang_json_strings(value,ARRAY['acceptanceReportDigest','fulfillmentType','merchantId','testedAt']) AND value->>'merchantId'='4611'
      AND value->>'fulfillmentType'='compute_card_hours' AND qixiang_iso_utc(value->>'testedAt') AND value->>'acceptanceReportDigest'~'^[0-9a-f]{64}$';
    WHEN 'reconciliation_acceptance' THEN RETURN qixiang_json_has_exact_keys(value,ARRAY['activeQuery','callback','lateSuccess','merchantId','reportDigest','testedAt'])
      AND qixiang_json_strings(value,ARRAY['merchantId','reportDigest','testedAt']) AND jsonb_typeof(value->'activeQuery')='boolean'
      AND jsonb_typeof(value->'callback')='boolean' AND jsonb_typeof(value->'lateSuccess')='boolean' AND value->>'merchantId'='4611'
      AND value->'callback'='true'::jsonb AND value->'activeQuery'='true'::jsonb AND value->'lateSuccess'='true'::jsonb
      AND qixiang_iso_utc(value->>'testedAt') AND value->>'reportDigest'~'^[0-9a-f]{64}$';
    WHEN 'approved_max_amount' THEN RETURN qixiang_json_has_exact_keys(value,ARRAY['approvedAt','currency','maxCents','merchantId','minCents','providerLimitRef'])
      AND qixiang_json_strings(value,ARRAY['approvedAt','currency','merchantId','providerLimitRef']) AND jsonb_typeof(value->'minCents')='number'
      AND value->>'merchantId'='4611' AND value->>'currency'='CNY' AND value->'minCents'='100'::jsonb AND jsonb_typeof(value->'maxCents')='number'
      AND (value->>'maxCents')::bigint BETWEEN 100 AND 4999999 AND qixiang_iso_utc(value->>'approvedAt') AND char_length(value->>'providerLimitRef') BETWEEN 3 AND 500;
    WHEN 'lot_accounting_acceptance' THEN RETURN qixiang_json_has_exact_keys(value,ARRAY['schemaVersion','stores','testReportDigest','testedAt'])
      AND value->'schemaVersion'='1'::jsonb AND qixiang_json_strings(value,ARRAY['testReportDigest','testedAt'])
      AND jsonb_typeof(value->'schemaVersion')='number' AND jsonb_typeof(value->'stores')='array'
      AND value->'stores'='["credit-orders","credits","device-commerce","fulfillment","topups-reversal","vast-market"]'::jsonb
      AND qixiang_iso_utc(value->>'testedAt') AND value->>'testReportDigest'~'^[0-9a-f]{64}$';
    ELSE RETURN false;
  END CASE;
END; $$;
