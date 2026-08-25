alter table "FLOTAYA"
  add column if not exists prob_contaminacion_pct numeric,
  add column if not exists riesgo_contaminacion text,
  add column if not exists contaminacion_probable boolean;
