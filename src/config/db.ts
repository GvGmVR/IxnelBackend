import { Pool } from 'pg';

export const pool = new Pool({
  host     : process.env.DB_HOST     || 'localhost',
  port     : parseInt(process.env.DB_PORT || '5432'),
  database : process.env.DB_NAME     || 'your_project_db',
  user     : process.env.DB_USER     || 'your_project_user',
  password : process.env.DB_PASSWORD || '',
});

// ── Test connection on startup ─────────────────────────────────────────────
pool.connect((err, client, release) => {
  if (err) {
    console.error('❌ Database connection failed:', err.message);
  } else {
    console.log('✅ Database connected successfully');
    release();
  }
});