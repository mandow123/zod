def request_provider_checkout():
    return None
def apply_payment_callback():
    return query_and_confirm_qixiang_payment()
def query_and_confirm_qixiang_payment():
    return None
def reconcile_pending_qixiang_payments():
    return None
def request_provider_refund():
    return None
def route(path):
    if path == "/api/auth/login": return "auth"
    if path == "/api/catalog": return "catalog"
    if path == "/api/orders": return "orders"
    if path == "/api/payments": return "payments"
