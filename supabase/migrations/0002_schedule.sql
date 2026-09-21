select cron.schedule(
  'seuil-check-signals',
  '*/2 * * * *',
  $$
  select net.http_post(
    url := 'https://<TON_PROJECT_REF>.supabase.co/functions/v1/check-signals',
    headers := jsonb_build_object(
      'Authorization', 'Bearer <TA_SERVICE_ROLE_KEY>',
      'Content-Type', 'application/json'
    )
  );
  $$
);
