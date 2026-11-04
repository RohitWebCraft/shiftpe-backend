require('dotenv').config();
const express = require('express');
const cors = require('cors');
if (!process.env.JWT_SECRET) { console.error('Set JWT_SECRET in .env'); process.exit(1); }
const app = express();
app.use(cors());
app.use(express.json());
app.get('/health', (_, res) => res.json({ ok: true }));
app.use('/auth', require('./routes/auth'));
app.use('/', require('./routes/profiles'));
app.use('/jobs', require('./routes/jobs'));
app.use('/matches', require('./routes/matches'));
app.use((err, req, res, next) => { console.error(err); res.status(err.status || 500).json({ error: err.status ? err.message : 'Server error' }); });
const port = process.env.PORT || 3000;
if (require.main === module) app.listen(port, () => console.log(`ShiftPe API on :${port}`));
module.exports = app;
