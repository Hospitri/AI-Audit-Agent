try {
    const { File } = require('undici');
    if (!globalThis.File) globalThis.File = File;
} catch (_) {}

require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const auditRouter = require('./routes/audit');
const hashPii = require('./routes/hash-pii');
const slackRoutes = require('./routes/slack-routes');

const app = express();
app.use('/slack', slackRoutes);
app.use(bodyParser.json());
app.use('/api/audit', auditRouter);
app.use('/api/hash-pii', hashPii);

process.on('SIGTERM', () =>
    console.log('[lifecycle] SIGTERM (Railway stopping container)')
);
process.on('SIGINT', () => console.log('[lifecycle] SIGINT'));
process.on('uncaughtException', e => console.error('[uncaughtException]', e));
process.on('unhandledRejection', e => console.error('[unhandledRejection]', e));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Audit Agent running on ${PORT}`));
