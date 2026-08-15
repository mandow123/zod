CREATE TABLE compute_demands (
  id uuid PRIMARY KEY,
  buyer_id uuid NOT NULL REFERENCES users(id),
  kind text NOT NULL CHECK (kind IN ('gpu', 'token_capacity', 'token_usage', 'rack', 'storage', 'apple_silicon')),
  title text NOT NULL CHECK (char_length(title) BETWEEN 2 AND 120),
  product_hint text NOT NULL,
  region text NOT NULL,
  quantity numeric(24,6) NOT NULL CHECK (quantity > 0),
  capacity_unit text NOT NULL,
  budget_max_cents bigint CHECK (budget_max_cents IS NULL OR budget_max_cents > 0),
  currency text NOT NULL DEFAULT 'CNY' CHECK (currency = 'CNY'),
  desired_start_at timestamptz NOT NULL,
  deadline_at timestamptz NOT NULL,
  description text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'matched', 'cancelled', 'expired', 'closed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CHECK (deadline_at > desired_start_at)
);
CREATE INDEX compute_demands_buyer_created ON compute_demands(buyer_id, created_at DESC);
CREATE INDEX compute_demands_open_search ON compute_demands(kind, region, deadline_at) WHERE status = 'open';

CREATE INDEX market_listings_supplier_created ON market_listings(supplier_id, created_at DESC);
