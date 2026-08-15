export const deletionBlockersQuery = `SELECT (
  EXISTS(SELECT 1 FROM kai_credit_orders o JOIN subject_memberships m ON m.subject_id = o.buyer_subject_id
    WHERE m.user_id = $1 AND m.status = 'active' AND o.status NOT IN ('cancelled', 'expired', 'refunded', 'closed'))
  OR EXISTS(SELECT 1 FROM kai_credit_orders o JOIN subject_memberships m ON m.subject_id = o.supplier_subject_id
    WHERE m.user_id = $1 AND m.status = 'active' AND o.status NOT IN ('cancelled', 'expired', 'refunded', 'closed'))
  OR EXISTS(SELECT 1 FROM orders WHERE buyer_id = $1
    AND status NOT IN ('accepted', 'cancelled', 'refunded', 'closed'))
  OR EXISTS(SELECT 1 FROM orders o JOIN supplier_profiles s ON s.id = o.supplier_id
    JOIN subject_memberships m ON m.subject_id = s.subject_id
    WHERE m.user_id = $1 AND m.status = 'active' AND o.status NOT IN ('accepted', 'cancelled', 'refunded', 'closed'))
  OR EXISTS(SELECT 1 FROM refunds WHERE requested_by = $1
    AND status IN ('requested', 'reviewing', 'approved', 'provider_pending'))
  OR EXISTS(SELECT 1 FROM disputes WHERE opened_by = $1
    AND status IN ('open', 'evidence_pending', 'reviewing'))
  OR EXISTS(SELECT 1 FROM invoices WHERE user_id = $1
    AND status IN ('requested', 'processing', 'red_pending'))
  OR EXISTS(SELECT 1 FROM compute_demands WHERE buyer_id = $1 AND status IN ('open', 'matched'))
  OR EXISTS(SELECT 1 FROM supplier_profiles s JOIN subject_memberships m ON m.subject_id = s.subject_id
    WHERE m.user_id = $1 AND m.status = 'active' AND s.status IN ('submitted', 'approved', 'suspended'))
) AS blocked`;

export const deletionLegalHoldReason = '存在尚未完成的订单、退款、争议、发票或供应方义务，需要依法完成后再匿名化。';
