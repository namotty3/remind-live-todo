const { createClient } = require('@supabase/supabase-js');

// このクライアントはNode.jsサーバー側でのみ使用し、ブラウザには公開しない。
// RLSはブラウザから直接Supabaseを叩く構成向けの保護であり、
// このアプリは全アクセスをこのサーバー経由（パスワード/LINE署名で保護）にしているため、
// service_role keyでRLSをバイパスして書き込みを行う。
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
);

module.exports = supabase;
