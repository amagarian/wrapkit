create extension if not exists pgcrypto;

create table if not exists template_families (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  vendor_name text not null,
  form_name text not null,
  document_type text not null default 'generic',
  latest_verified_version_id uuid,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists template_versions (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references template_families(id) on delete cascade,
  template_id text not null unique,
  version text not null,
  status text not null check (status in ('local-draft', 'community-submitted', 'verified')),
  source_pdf_path text,
  preview_image_path text,
  fingerprint jsonb not null,
  template_payload jsonb not null,
  notes text,
  submitted_at timestamptz,
  verified_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (family_id, version)
);

alter table template_families
  add constraint template_families_latest_verified_fk
  foreign key (latest_verified_version_id)
  references template_versions(id)
  on delete set null;

create table if not exists template_submissions (
  id uuid primary key default gen_random_uuid(),
  template_id text not null,
  template_name text not null,
  source_project_id text,
  pdf_file_name text not null,
  source_pdf_path text,
  status text not null check (status in ('pending-upload', 'queued', 'submitted', 'approved', 'rejected')),
  fingerprint jsonb not null,
  template_payload jsonb not null,
  notes text,
  submitted_at timestamptz not null default timezone('utc', now())
);

create index if not exists template_versions_family_status_idx
  on template_versions (family_id, status);

create index if not exists template_versions_status_idx
  on template_versions (status);

create index if not exists template_submissions_status_idx
  on template_submissions (status);

create index if not exists template_versions_fingerprint_idx
  on template_versions using gin (fingerprint jsonb_path_ops);

create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$ language plpgsql;

drop trigger if exists set_template_families_updated_at on template_families;
create trigger set_template_families_updated_at
before update on template_families
for each row execute function set_updated_at();

drop trigger if exists set_template_versions_updated_at on template_versions;
create trigger set_template_versions_updated_at
before update on template_versions
for each row execute function set_updated_at();
