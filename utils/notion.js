const { Client } = require('@notionhq/client');
const notion = new Client({ auth: process.env.NOTION_API_KEY });

async function upsertDailyMetrics({ dateISO, metrics }) {
    const query = await notion.databases.query({
        database_id: process.env.NOTION_METRICS_DB_ID,
        filter: {
            property: 'Date',
            date: { equals: dateISO.split('T')[0] },
        },
    });

    const props = {
        Date: { date: { start: dateISO } },
        ...Object.fromEntries(
            Object.entries(metrics).map(([k, v]) => [
                k,
                { number: Number(v) || 0 },
            ])
        ),
    };

    if (query.results.length) {
        const pageId = query.results[0].id;
        await notion.pages.update({ page_id: pageId, properties: props });
        return { updated: true, pageId };
    } else {
        const created = await notion.pages.create({
            parent: { database_id: process.env.NOTION_METRICS_DB_ID },
            properties: props,
        });
        return { created: true, pageId: created.id };
    }
}

module.exports = { upsertDailyMetrics };
