-- shopkart "prod" schema: state after migrations 0001-0006.
-- Idempotent: drops and recreates everything, including pgwarden's audit schema.

DROP SCHEMA IF EXISTS pgwarden CASCADE;
DROP TABLE IF EXISTS orders CASCADE;
DROP TABLE IF EXISTS users CASCADE;
DROP TABLE IF EXISTS schema_migrations CASCADE;

CREATE TABLE schema_migrations (
  version    text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id         bigserial PRIMARY KEY,
  email      text NOT NULL,
  full_name  text NOT NULL,
  phone      text,
  city       text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE orders (
  id           bigserial PRIMARY KEY,
  user_id      bigint NOT NULL REFERENCES users(id),
  amount_paise integer NOT NULL CHECK (amount_paise > 0),
  status       text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX orders_user_id_idx ON orders (user_id);

INSERT INTO schema_migrations (version) VALUES
  ('0001'), ('0002'), ('0003'), ('0004'), ('0005'), ('0006');
