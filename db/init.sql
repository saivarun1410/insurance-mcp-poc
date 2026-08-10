-- Synthetic life-insurance schema for the MCP POC.
-- Nothing here is derived from any production system; all data is invented.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE products (
    product_code     TEXT PRIMARY KEY,
    name             TEXT NOT NULL,
    product_type     TEXT NOT NULL CHECK (product_type IN ('term', 'whole', 'universal', 'variable')),
    min_issue_age    INT  NOT NULL,
    max_issue_age    INT  NOT NULL,
    min_face_amount  BIGINT NOT NULL,
    max_face_amount  BIGINT NOT NULL,
    available_states TEXT[] NOT NULL,
    active           BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE underwriting_rules (
    rule_code    TEXT PRIMARY KEY,
    product_code TEXT NOT NULL REFERENCES products(product_code),
    category     TEXT NOT NULL,
    description  TEXT NOT NULL,
    -- Plain-language trigger; a real engine would store a compiled expression.
    condition    TEXT NOT NULL,
    outcome      TEXT NOT NULL CHECK (outcome IN ('accept', 'refer', 'decline', 'rate_up', 'require_evidence'))
);

CREATE TABLE applications (
    application_number  TEXT PRIMARY KEY,
    applicant_name      TEXT NOT NULL,
    applicant_age       INT  NOT NULL,
    applicant_state     TEXT NOT NULL,
    product_code        TEXT NOT NULL REFERENCES products(product_code),
    face_amount         BIGINT NOT NULL,
    status              TEXT NOT NULL,
    current_step        TEXT NOT NULL,
    assigned_underwriter TEXT,
    submitted_at        TIMESTAMPTZ NOT NULL,
    updated_at          TIMESTAMPTZ NOT NULL
);

CREATE TABLE application_events (
    id                 BIGSERIAL PRIMARY KEY,
    application_number TEXT NOT NULL REFERENCES applications(application_number),
    occurred_at        TIMESTAMPTZ NOT NULL,
    event              TEXT NOT NULL,
    detail             TEXT
);

CREATE INDEX ON application_events (application_number, occurred_at);

-- Embeddings are written by scripts/seed.mjs; dimension must match EMBEDDING_DIM in src/embed.js.
CREATE TABLE policy_documents (
    doc_id       TEXT PRIMARY KEY,
    title        TEXT NOT NULL,
    doc_type     TEXT NOT NULL,
    product_code TEXT REFERENCES products(product_code),
    content      TEXT NOT NULL,
    embedding    vector(256),
    -- Lexical half of hybrid retrieval. Maintained by Postgres, so it can never drift
    -- out of sync with content the way a separately-populated column would.
    content_tsv  tsvector GENERATED ALWAYS AS (to_tsvector('english', title || ' ' || content)) STORED
);

CREATE INDEX ON policy_documents USING gin (content_tsv);

-- Deliberately no ivfflat/HNSW index here. Approximate indexes only pay off once the corpus
-- is large; over a handful of rows an ivfflat probe scans a near-empty partition and silently
-- returns wrong or short result sets. At this size an exact scan is both correct and instant.
-- Add `USING hnsw (embedding vector_cosine_ops)` once the corpus is in the tens of thousands.


INSERT INTO products (product_code, name, product_type, min_issue_age, max_issue_age, min_face_amount, max_face_amount, available_states) VALUES
('TRM-20',  'SecureTerm 20-Year',        'term',      18, 65,   50000, 5000000, ARRAY['CA','TX','NY','FL','IL','OH','WA']),
('TRM-30',  'SecureTerm 30-Year',        'term',      18, 55,  100000, 3000000, ARRAY['CA','TX','FL','IL','OH']),
('WL-100',  'Heritage Whole Life',       'whole',      0, 80,   25000, 2000000, ARRAY['CA','TX','NY','FL','IL','OH','WA','AZ']),
('UL-200',  'FlexBuild Universal Life',  'universal', 18, 75,  100000,10000000, ARRAY['CA','TX','NY','IL']),
('VUL-300', 'Horizon Variable UL',       'variable',  21, 70,  250000,10000000, ARRAY['CA','NY','IL']);

INSERT INTO underwriting_rules (rule_code, product_code, category, description, condition, outcome) VALUES
('TRM20-AGE-01', 'TRM-20', 'age',       'Applicants over 60 require a paramedical exam regardless of face amount.', 'applicant_age > 60', 'require_evidence'),
('TRM20-FACE-01','TRM-20', 'face',      'Face amounts above $1,000,000 are referred to a senior underwriter.',      'face_amount > 1000000', 'refer'),
('TRM20-FACE-02','TRM-20', 'face',      'Face amounts at or below $250,000 for ages under 45 qualify for accelerated underwriting.', 'face_amount <= 250000 AND applicant_age < 45', 'accept'),
('TRM30-AGE-01', 'TRM-30', 'age',       'Issue ages above 55 are ineligible for the 30-year term.',                'applicant_age > 55', 'decline'),
('TRM30-BUILD-01','TRM-30','build',     'BMI above 38 triggers a table rating.',                                   'bmi > 38', 'rate_up'),
('WL100-AGE-01', 'WL-100', 'age',       'Juvenile policies under age 15 require a guardian signature and proof of insurable interest.', 'applicant_age < 15', 'require_evidence'),
('WL100-FACE-01','WL-100', 'face',      'Face amounts above $500,000 require full financial justification.',       'face_amount > 500000', 'require_evidence'),
('UL200-FACE-01','UL-200', 'face',      'Face amounts above $5,000,000 require reinsurance facultative review.',   'face_amount > 5000000', 'refer'),
('UL200-FIN-01', 'UL-200', 'financial', 'Income replacement multiples above 20x annual income are declined.',      'face_amount > annual_income * 20', 'decline'),
('VUL300-SUIT-01','VUL-300','suitability','Variable products require a completed suitability questionnaire before issue.', 'suitability_form IS NULL', 'require_evidence'),
('VUL300-AGE-01','VUL-300','age',       'Issue ages above 70 are ineligible.',                                     'applicant_age > 70', 'decline');

INSERT INTO applications (application_number, applicant_name, applicant_age, applicant_state, product_code, face_amount, status, current_step, assigned_underwriter, submitted_at, updated_at) VALUES
('APP-100241', 'Dana Whitfield',   34, 'TX', 'TRM-20',  250000, 'approved',            'issued',              'M. Alvarez', '2026-06-02 14:11:00+00', '2026-06-09 09:32:00+00'),
('APP-100242', 'Rowan Kessler',    61, 'CA', 'TRM-20', 1500000, 'pending_underwriting','awaiting_paramedical','J. Osei',    '2026-06-14 10:05:00+00', '2026-07-28 16:20:00+00'),
('APP-100243', 'Priya Raghunathan',29, 'IL', 'TRM-30',  750000, 'pending_requirements','awaiting_aps',        'M. Alvarez', '2026-07-01 08:47:00+00', '2026-08-03 11:02:00+00'),
('APP-100244', 'Ellis Tran',        8, 'FL', 'WL-100',  100000, 'pending_requirements','awaiting_guardian_signature', 'S. Bhatt', '2026-07-19 13:26:00+00', '2026-08-05 15:44:00+00'),
('APP-100245', 'Marguerite Osei',  47, 'NY', 'UL-200', 6000000, 'referred',            'facultative_review',  'D. Lindqvist','2026-07-22 09:15:00+00', '2026-08-07 10:10:00+00'),
('APP-100246', 'Tobias Lindqvist', 72, 'CA', 'VUL-300',500000,  'declined',            'closed',              'J. Osei',    '2026-07-25 17:03:00+00', '2026-07-26 12:00:00+00');

INSERT INTO application_events (application_number, occurred_at, event, detail) VALUES
('APP-100241', '2026-06-02 14:11:00+00', 'submitted',            'Application received via agent portal'),
('APP-100241', '2026-06-03 09:00:00+00', 'accelerated_eligible', 'Matched TRM20-FACE-02, no exam required'),
('APP-100241', '2026-06-08 16:40:00+00', 'approved',             'Standard non-tobacco class'),
('APP-100241', '2026-06-09 09:32:00+00', 'issued',               'Policy delivered electronically'),
('APP-100242', '2026-06-14 10:05:00+00', 'submitted',            'Application received via agent portal'),
('APP-100242', '2026-06-15 11:20:00+00', 'rule_triggered',       'TRM20-AGE-01: paramedical exam required'),
('APP-100242', '2026-06-15 11:21:00+00', 'rule_triggered',       'TRM20-FACE-01: referred to senior underwriter'),
('APP-100242', '2026-07-28 16:20:00+00', 'requirement_ordered',  'Paramedical exam scheduled 2026-08-14'),
('APP-100243', '2026-07-01 08:47:00+00', 'submitted',            'Application received via direct-to-consumer flow'),
('APP-100243', '2026-07-14 10:30:00+00', 'requirement_ordered',  'Attending physician statement requested'),
('APP-100243', '2026-08-03 11:02:00+00', 'requirement_followup', 'Second request sent to provider'),
('APP-100244', '2026-07-19 13:26:00+00', 'submitted',            'Juvenile application'),
('APP-100244', '2026-08-05 15:44:00+00', 'rule_triggered',       'WL100-AGE-01: guardian signature outstanding'),
('APP-100245', '2026-07-22 09:15:00+00', 'submitted',            'High face amount application'),
('APP-100245', '2026-08-07 10:10:00+00', 'rule_triggered',       'UL200-FACE-01: facultative reinsurance review'),
('APP-100246', '2026-07-25 17:03:00+00', 'submitted',            'Variable UL application'),
('APP-100246', '2026-07-26 12:00:00+00', 'declined',             'VUL300-AGE-01: issue age above 70');
