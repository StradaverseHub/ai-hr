CREATE INDEX job_run_key_ran_at_id_idx ON public.job_run USING btree (job_key, ran_at DESC, id DESC);
