CREATE INDEX custom_report_occurrence_report_scheduled_id_idx ON public.custom_report_occurrence USING btree (report_id, scheduled_for DESC, id DESC);
