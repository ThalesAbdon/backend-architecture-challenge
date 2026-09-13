-- Schema da base de mobilidade.
-- Migracoes historicas foram consolidadas neste arquivo em 2024-11.

SET NAMES utf8mb4;
SET SESSION sql_mode = '';

CREATE TABLE cities (
  id_city     INT PRIMARY KEY,
  name        VARCHAR(120) NOT NULL,
  state       CHAR(2) NOT NULL,
  center_lat  DECIMAL(10, 7) NOT NULL,
  center_lng  DECIMAL(10, 7) NOT NULL,
  active      TINYINT(1) NOT NULL DEFAULT 1
) ENGINE = InnoDB;

INSERT INTO cities VALUES
  (1, 'Muzambinho', 'MG', -21.3767000, -46.5253000, 1),
  (2, 'Guaxupe',    'MG', -21.3050000, -46.7128000, 1),
  (3, 'Alfenas',    'MG', -21.4256000, -45.9472000, 1);

CREATE TABLE users (
  id_user     INT PRIMARY KEY AUTO_INCREMENT,
  name        VARCHAR(120) NOT NULL,
  email       VARCHAR(160) NOT NULL,
  phone       VARCHAR(20)  NOT NULL,
  city_id     INT NOT NULL,
  rating      DECIMAL(3, 2) NOT NULL DEFAULT 5.00,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_users_email (email)
) ENGINE = InnoDB;

CREATE TABLE drivers (
  id_driver         INT PRIMARY KEY AUTO_INCREMENT,
  name              VARCHAR(120) NOT NULL,
  email             VARCHAR(160) NOT NULL,
  phone             VARCHAR(20)  NOT NULL,
  cpf               VARCHAR(14)  NOT NULL,
  city_id           INT NOT NULL,
  category          VARCHAR(20)  NOT NULL DEFAULT 'standard',
  status            VARCHAR(20)  NOT NULL DEFAULT 'offline',
  rating            DECIMAL(3, 2) NOT NULL DEFAULT 5.00,
  total_trips       INT NOT NULL DEFAULT 0,
  vehicle_plate     VARCHAR(10)  NOT NULL,
  vehicle_model     VARCHAR(60)  NOT NULL,
  vehicle_brand     VARCHAR(40)  NOT NULL,
  vehicle_color     VARCHAR(30)  NOT NULL,
  vehicle_year      SMALLINT     NOT NULL,
  documents_ok      TINYINT(1)   NOT NULL DEFAULT 1,
  cnh_expires_at    DATE         NULL,
  bank_account      VARCHAR(40)  NULL,
  wallet_balance    DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
  last_connection   DATETIME     NULL,
  created_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_drivers_email (email),
  KEY idx_drivers_city (city_id)
) ENGINE = InnoDB;

CREATE TABLE trips (
  id_trip         BIGINT PRIMARY KEY AUTO_INCREMENT,
  reference       CHAR(24) NOT NULL,
  user_id         INT NOT NULL,
  driver_id       INT NULL,
  city_id         INT NOT NULL,
  status          VARCHAR(24) NOT NULL,
  payment_method  VARCHAR(20) NOT NULL DEFAULT 'cash',
  origin_lat      DECIMAL(10, 7) NOT NULL,
  origin_lng      DECIMAL(10, 7) NOT NULL,
  origin_address  VARCHAR(200) NOT NULL,
  dest_lat        DECIMAL(10, 7) NOT NULL,
  dest_lng        DECIMAL(10, 7) NOT NULL,
  dest_address    VARCHAR(200) NOT NULL,
  distance_m      INT NOT NULL DEFAULT 0,
  duration_s      INT NOT NULL DEFAULT 0,
  price           DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
  canceled_by     VARCHAR(20) NULL,
  created_at      DATETIME NOT NULL,
  finished_at     DATETIME NULL,
  UNIQUE KEY uq_trips_reference (reference),
  KEY idx_trips_city_created (city_id, created_at),
  KEY idx_trips_driver_created (driver_id, created_at)
) ENGINE = InnoDB;

CREATE TABLE app_config (
  chave   VARCHAR(60) PRIMARY KEY,
  valor   VARCHAR(200) NOT NULL,
  nota    VARCHAR(200) NULL
) ENGINE = InnoDB;

INSERT INTO app_config VALUES
  ('painel.janela',   '150', 'corridas por publicacao do feed de operacao'),
  ('painel.periodo',  '2000', 'ms entre publicacoes'),
  ('pricing.moeda',   'BRL', NULL),
  ('geo.provedor',    'principal', NULL);

CREATE TABLE trip_events (
  id_event    BIGINT PRIMARY KEY AUTO_INCREMENT,
  trip_id     BIGINT NOT NULL,
  event_type  VARCHAR(40) NOT NULL,
  payload     JSON NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_trip_events_trip (trip_id)
) ENGINE = InnoDB;

-- ---------------------------------------------------------------------------
-- Seed
-- ---------------------------------------------------------------------------

INSERT INTO users (name, email, phone, city_id, rating)
SELECT
  CONCAT('Passageiro ', n),
  CONCAT('passageiro', n, '@exemplo.com.br'),
  CONCAT('98', LPAD(n, 9, '0')),
  1 + (n % 3),
  4.00 + (n % 100) / 100
FROM (
  SELECT a.d + b.d * 10 + c.d * 100 AS n
  FROM (SELECT 0 d UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4
        UNION SELECT 5 UNION SELECT 6 UNION SELECT 7 UNION SELECT 8 UNION SELECT 9) a,
       (SELECT 0 d UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4
        UNION SELECT 5 UNION SELECT 6 UNION SELECT 7 UNION SELECT 8 UNION SELECT 9) b,
       (SELECT 0 d UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4
        UNION SELECT 5 UNION SELECT 6 UNION SELECT 7 UNION SELECT 8 UNION SELECT 9) c
) seq
WHERE n > 0;

INSERT INTO drivers (
  name, email, phone, cpf, city_id, category, status, rating, total_trips,
  vehicle_plate, vehicle_model, vehicle_brand, vehicle_color, vehicle_year,
  documents_ok, cnh_expires_at, bank_account, wallet_balance
)
SELECT
  CONCAT('Motorista ', n),
  CONCAT('motorista', n, '@exemplo.com.br'),
  CONCAT('98', LPAD(n, 9, '0')),
  LPAD(n * 137, 11, '0'),
  1 + (n % 3),
  ELT(1 + (n % 3), 'standard', 'comfort', 'moto'),
  'offline',
  4.20 + (n % 80) / 100,
  120 + n * 7,
  CONCAT(CHAR(65 + (n % 26)), CHAR(65 + ((n + 7) % 26)), CHAR(65 + ((n + 13) % 26)),
         (n % 10), CHAR(65 + (n % 26)), ((n + 3) % 10), ((n + 5) % 10)),
  ELT(1 + (n % 6), 'Onix', 'HB20', 'Argo', 'Kwid', 'Mobi', 'Ka'),
  ELT(1 + (n % 6), 'Chevrolet', 'Hyundai', 'Fiat', 'Renault', 'Fiat', 'Ford'),
  ELT(1 + (n % 5), 'Branco', 'Prata', 'Preto', 'Vermelho', 'Cinza'),
  2015 + (n % 9),
  1,
  DATE_ADD(CURDATE(), INTERVAL (300 + n) DAY),
  CONCAT('001-', LPAD(n, 8, '0')),
  (n * 13) % 900
FROM (
  SELECT a.d + b.d * 10 + c.d * 100 AS n
  FROM (SELECT 0 d UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4
        UNION SELECT 5 UNION SELECT 6 UNION SELECT 7 UNION SELECT 8 UNION SELECT 9) a,
       (SELECT 0 d UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4
        UNION SELECT 5 UNION SELECT 6 UNION SELECT 7 UNION SELECT 8 UNION SELECT 9) b,
       (SELECT 0 d UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4
        UNION SELECT 5 UNION SELECT 6 UNION SELECT 7 UNION SELECT 8 UNION SELECT 9) c
) seq
WHERE n BETWEEN 1 AND 150
ORDER BY n;

-- Historico de corridas. Volume real de ~4 meses de operacao.
INSERT INTO trips (
  reference, user_id, driver_id, city_id, status, payment_method,
  origin_lat, origin_lng, origin_address, dest_lat, dest_lng, dest_address,
  distance_m, duration_s, price, canceled_by, created_at, finished_at
)
SELECT
  LPAD(CONV(n * 2654435761, 10, 36), 24, '0'),
  1 + (n % 999),
  1 + (n % 150),
  1 + (n % 3),
  ELT(1 + (n % 10), 'finished', 'finished', 'finished', 'finished', 'finished',
                    'finished', 'finished', 'canceled', 'finished', 'finished'),
  ELT(1 + (n % 4), 'cash', 'credit', 'pix', 'wallet'),
  -21.3767 + ((n % 400) - 200) / 4000,
  -46.5253 + ((n % 377) - 188) / 4000,
  CONCAT('Rua ', 1 + (n % 300), ', ', 100 + (n % 900), ' - Bairro ', 1 + (n % 40)),
  -21.3767 + ((n % 311) - 155) / 4000,
  -46.5253 + ((n % 289) - 144) / 4000,
  CONCAT('Avenida ', 1 + (n % 120), ', ', 100 + (n % 800), ' - Bairro ', 1 + (n % 40)),
  800 + (n % 18000),
  240 + (n % 2400),
  7.50 + (n % 6000) / 100,
  CASE WHEN (n % 10) = 7 THEN ELT(1 + (n % 2), 'user', 'driver') ELSE NULL END,
  DATE_SUB(NOW(), INTERVAL (n % 172800) MINUTE),
  DATE_SUB(NOW(), INTERVAL ((n % 172800) - 20) MINUTE)
FROM (
  SELECT a.d + b.d * 10 + c.d * 100 + d.d * 1000 + e.d * 10000 AS n
  FROM (SELECT 0 d UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4
        UNION SELECT 5 UNION SELECT 6 UNION SELECT 7 UNION SELECT 8 UNION SELECT 9) a,
       (SELECT 0 d UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4
        UNION SELECT 5 UNION SELECT 6 UNION SELECT 7 UNION SELECT 8 UNION SELECT 9) b,
       (SELECT 0 d UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4
        UNION SELECT 5 UNION SELECT 6 UNION SELECT 7 UNION SELECT 8 UNION SELECT 9) c,
       (SELECT 0 d UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4
        UNION SELECT 5 UNION SELECT 6 UNION SELECT 7 UNION SELECT 8 UNION SELECT 9) d,
       (SELECT 0 d UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4
        UNION SELECT 5 UNION SELECT 6 UNION SELECT 7 UNION SELECT 8 UNION SELECT 9) e
) seq
WHERE n > 0;

INSERT INTO trip_events (trip_id, event_type, payload, created_at)
SELECT id_trip, 'trip.finished', JSON_OBJECT('price', price, 'distance_m', distance_m), finished_at
FROM trips
WHERE status = 'finished' AND id_trip % 7 = 0;
