-- Aggregate-only product metrics. Never store IP, UA, email, or user ids here.
CREATE TABLE IF NOT EXISTS metric_daily (
  day TEXT NOT NULL,           -- YYYY-MM-DD UTC
  metric TEXT NOT NULL,        -- e.g. page_view_human, lab_save_human, register_human
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, metric)
);

CREATE INDEX IF NOT EXISTS idx_metric_daily_metric ON metric_daily(metric);
