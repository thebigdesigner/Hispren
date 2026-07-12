CREATE ROLE hispren_app LOGIN PASSWORD 'dev_app_pw';
GRANT USAGE ON SCHEMA public TO hispren_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO hispren_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO hispren_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO hispren_app;

-- seed two tenants + a person in A
INSERT INTO tenants (id, name, subdomain) VALUES
 ('11111111-1111-1111-1111-111111111111','Church A','church-a'),
 ('22222222-2222-2222-2222-222222222222','Church B','church-b');
INSERT INTO persons (id, tenant_id, first_name, last_name, phone, date_of_birth) VALUES
 ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','11111111-1111-1111-1111-111111111111',
  'Amaka','Okafor','+2348012345678','1990-03-14');
