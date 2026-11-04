const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
module.exports = { pool, q: (text, params) => pool.query(text, params) };
