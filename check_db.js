const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

(async () => {
    try {
        const res = await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public'");
        console.log('Tables:', res.rows.map(r => r.table_name));
        process.exit(0);
    } catch (err) {
        console.error('DB Error:', err.message);
        process.exit(1);
    }
})();
