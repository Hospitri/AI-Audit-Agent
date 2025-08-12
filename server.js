try {
    const { File } = require('undici');
    if (!globalThis.File) globalThis.File = File;
} catch (_) {}

require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const auditRouter = require('./routes/audit');

const app = express();
app.use(bodyParser.json());
app.use('/api/audit', auditRouter);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Audit Agent running on ${PORT}`));
